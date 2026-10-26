import type { Database, Queryable } from '../../db/database';

export interface PrescriptionRecord {
  id: string;
  consultationId: string;
  doctorId: string;
  patientId: string;
  diagnosisEnc: string;
  medicationsEnc: string;
  adviceEnc: string | null;
  followUpDate: string | null;
  documentStatus: 'pending' | 'ready' | 'failed';
  documentKey: string | null;
  issuedAt: Date;
}

interface Row {
  id: string;
  consultation_id: string;
  doctor_id: string;
  patient_id: string;
  diagnosis_enc: string;
  medications_enc: string;
  advice_enc: string | null;
  follow_up_date: string | null;
  document_status: 'pending' | 'ready' | 'failed';
  document_key: string | null;
  issued_at: Date;
}

const toRecord = (r: Row): PrescriptionRecord => ({
  id: r.id,
  consultationId: r.consultation_id,
  doctorId: r.doctor_id,
  patientId: r.patient_id,
  diagnosisEnc: r.diagnosis_enc,
  medicationsEnc: r.medications_enc,
  adviceEnc: r.advice_enc,
  followUpDate: r.follow_up_date,
  documentStatus: r.document_status,
  documentKey: r.document_key,
  issuedAt: r.issued_at,
});

const SELECT = `SELECT id, consultation_id, doctor_id, patient_id, diagnosis_enc, medications_enc, advice_enc,
                       to_char(follow_up_date, 'YYYY-MM-DD') AS follow_up_date, document_status, document_key, issued_at
                  FROM prescriptions`;

export class PrescriptionsRepository {
  private readonly db: Database;

  constructor({ db }: { db: Database }) {
    this.db = db;
  }

  async insert(
    q: Queryable,
    p: Pick<
      PrescriptionRecord,
      | 'consultationId'
      | 'doctorId'
      | 'patientId'
      | 'diagnosisEnc'
      | 'medicationsEnc'
      | 'adviceEnc'
      | 'followUpDate'
    >,
  ): Promise<PrescriptionRecord> {
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO prescriptions (consultation_id, doctor_id, patient_id, diagnosis_enc, medications_enc, advice_enc, follow_up_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        p.consultationId,
        p.doctorId,
        p.patientId,
        p.diagnosisEnc,
        p.medicationsEnc,
        p.adviceEnc,
        p.followUpDate,
      ],
    );
    return (await this.findById(rows[0]!.id, q))!;
  }

  async findById(id: string, q: Queryable = this.db): Promise<PrescriptionRecord | null> {
    const { rows } = await q.query<Row>(`${SELECT} WHERE id = $1`, [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByConsultation(consultationId: string): Promise<PrescriptionRecord | null> {
    const { rows } = await this.db.query<Row>(`${SELECT} WHERE consultation_id = $1`, [consultationId]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async setDocument(id: string, status: 'ready' | 'failed', key: string | null): Promise<void> {
    await this.db.query('UPDATE prescriptions SET document_status = $2, document_key = $3 WHERE id = $1', [
      id,
      status,
      key,
    ]);
  }
}
