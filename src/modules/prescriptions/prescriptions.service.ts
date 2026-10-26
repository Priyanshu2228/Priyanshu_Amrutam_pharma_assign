import PDFDocument from 'pdfkit';
import type { Readable } from 'node:stream';
import type { Database } from '../../db/database';
import type { OutboxService } from '../../jobs/outbox';
import type { DocumentStorage } from '../../lib/document-storage';
import { ConflictError, NotFoundError, PgCodes, pgCode } from '../../lib/errors';
import type { FieldCrypto } from '../../lib/field-crypto';
import type { AuditService } from '../audit/audit.service';
import type { Viewer } from '../consultations/consultations.service';
import type { ConsultationsRepository } from '../consultations/consultations.repository';
import type { DoctorsRepository } from '../doctors/doctors.repository';
import type { UsersRepository } from '../users/users.repository';
import type { PrescriptionRecord, PrescriptionsRepository } from './prescriptions.repository';

export interface Medication {
  name: string;
  dosage: string;
  frequency: string;
  durationDays: number;
  instructions?: string;
}

export interface PrescriptionInput {
  diagnosis: string;
  medications: Medication[];
  advice?: string;
  followUpDate?: string;
}

export interface PrescriptionView {
  id: string;
  consultationId: string;
  doctorId: string;
  patientId: string;
  diagnosis: string;
  medications: Medication[];
  advice: string | null;
  followUpDate: string | null;
  document: { status: 'pending' | 'ready' | 'failed' };
  issuedAt: string;
}

interface Deps {
  db: Database;
  fieldCrypto: FieldCrypto;
  auditService: AuditService;
  outboxService: OutboxService;
  documentStorage: DocumentStorage;
  consultationsRepository: ConsultationsRepository;
  prescriptionsRepository: PrescriptionsRepository;
  doctorsRepository: DoctorsRepository;
  usersRepository: UsersRepository;
}

export class PrescriptionsService {
  constructor(private readonly d: Deps) {}

  async issue(doctorId: string, consultationId: string, input: PrescriptionInput): Promise<PrescriptionView> {
    try {
      const record = await this.d.db.withTransaction(async (tx) => {
        const c = await this.d.consultationsRepository.findById(consultationId, tx, { forUpdate: true });
        if (!c || c.doctorId !== doctorId) throw new NotFoundError('Consultation');
        if (c.status !== 'in_progress' && c.status !== 'completed') {
          throw new ConflictError(
            'CONSULTATION_NOT_ACTIVE',
            'Prescriptions can only be issued during or after a consultation',
          );
        }
        const p = await this.d.prescriptionsRepository.insert(tx, {
          consultationId: c.id,
          doctorId,
          patientId: c.patientId,
          diagnosisEnc: this.d.fieldCrypto.encrypt(input.diagnosis),
          medicationsEnc: this.d.fieldCrypto.encryptJson(input.medications),
          adviceEnc: this.d.fieldCrypto.encryptNullable(input.advice),
          followUpDate: input.followUpDate ?? null,
        });
        // PDF rendering is CPU-heavy: hand it to the worker via the outbox.
        await this.d.outboxService.add(tx, {
          type: 'prescription.issued',
          aggregateType: 'prescription',
          aggregateId: p.id,
          payload: { patientId: c.patientId, consultationId: c.id },
        });
        await this.d.auditService.record(
          {
            action: 'prescription.issued',
            entityType: 'prescription',
            entityId: p.id,
            metadata: { consultationId: c.id, medicationCount: input.medications.length },
          },
          tx,
        );
        return p;
      });
      return this.present(record);
    } catch (err) {
      if (pgCode(err) === PgCodes.UNIQUE_VIOLATION) {
        throw new ConflictError(
          'PRESCRIPTION_EXISTS',
          'A prescription was already issued for this consultation',
        );
      }
      throw err;
    }
  }

  async getForConsultation(viewer: Viewer, consultationId: string): Promise<PrescriptionView> {
    const p = await this.d.prescriptionsRepository.findByConsultation(consultationId);
    if (!p || !this.canRead(viewer, p)) throw new NotFoundError('Prescription');
    await this.d.auditService.record({
      action: 'prescription.viewed',
      entityType: 'prescription',
      entityId: p.id,
    });
    return this.present(p);
  }

  async openDocument(
    viewer: Viewer,
    prescriptionId: string,
  ): Promise<{ stream: Readable; filename: string }> {
    const p = await this.d.prescriptionsRepository.findById(prescriptionId);
    if (!p || !this.canRead(viewer, p)) throw new NotFoundError('Prescription');
    if (p.documentStatus !== 'ready' || !p.documentKey) {
      throw new ConflictError('DOCUMENT_NOT_READY', 'The prescription document is still being generated');
    }
    await this.d.auditService.record({
      action: 'prescription.downloaded',
      entityType: 'prescription',
      entityId: p.id,
    });
    return { stream: await this.d.documentStorage.get(p.documentKey), filename: `prescription-${p.id}.pdf` };
  }

  /** Worker job: renders the PDF and stores it. Idempotent (same key, overwritten). */
  async renderDocument(prescriptionId: string): Promise<void> {
    const p = await this.d.prescriptionsRepository.findById(prescriptionId);
    if (!p || p.documentStatus === 'ready') return;
    const [doctor, patient] = await Promise.all([
      this.d.doctorsRepository.findById(p.doctorId),
      this.d.usersRepository.getProfile(p.patientId),
    ]);
    const view = this.present(p);
    const pdf = await renderPdf(
      view,
      doctor?.displayName ?? 'Doctor',
      doctor?.registrationNumber ?? '',
      patient?.fullName ?? 'Patient',
    );
    const key = `prescriptions/${p.patientId}/${p.id}.pdf`;
    try {
      await this.d.documentStorage.put(key, pdf, 'application/pdf');
      await this.d.prescriptionsRepository.setDocument(p.id, 'ready', key);
    } catch (err) {
      await this.d.prescriptionsRepository.setDocument(p.id, 'failed', null);
      throw err;
    }
  }

  private canRead(viewer: Viewer, p: PrescriptionRecord): boolean {
    return (
      (viewer.role === 'patient' && p.patientId === viewer.userId) ||
      (viewer.role === 'doctor' && p.doctorId === viewer.userId)
    );
  }

  private present(p: PrescriptionRecord): PrescriptionView {
    return {
      id: p.id,
      consultationId: p.consultationId,
      doctorId: p.doctorId,
      patientId: p.patientId,
      diagnosis: this.d.fieldCrypto.decrypt(p.diagnosisEnc),
      medications: this.d.fieldCrypto.decryptJson<Medication[]>(p.medicationsEnc),
      advice: this.d.fieldCrypto.decryptNullable(p.adviceEnc),
      followUpDate: p.followUpDate,
      document: { status: p.documentStatus },
      issuedAt: p.issuedAt.toISOString(),
    };
  }
}

function renderPdf(
  p: PrescriptionView,
  doctorName: string,
  registration: string,
  patientName: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Prescription ${p.id}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('Amrutam Teleconsultation — Prescription', { align: 'center' }).moveDown();
    doc.fontSize(11).text(`Doctor: ${doctorName} (Reg. ${registration})`);
    doc.text(`Patient: ${patientName}`);
    doc.text(`Issued: ${new Date(p.issuedAt).toUTCString()}`);
    doc.text(`Reference: ${p.id}`).moveDown();
    doc.fontSize(13).text('Diagnosis').fontSize(11).text(p.diagnosis).moveDown();
    doc.fontSize(13).text('Medications');
    p.medications.forEach((m, i) => {
      doc
        .fontSize(11)
        .text(
          `${i + 1}. ${m.name} — ${m.dosage}, ${m.frequency}, ${m.durationDays} day(s)${m.instructions ? ` (${m.instructions})` : ''}`,
        );
    });
    if (p.advice) doc.moveDown().fontSize(13).text('Advice').fontSize(11).text(p.advice);
    if (p.followUpDate) doc.moveDown().text(`Follow-up on: ${p.followUpDate}`);
    doc.end();
  });
}
