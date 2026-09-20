const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

/* ---------------- in-memory sessions ---------------- */
const sessions = new Map(); // token -> {role, id, hospitalId}

function newToken() { return crypto.randomBytes(24).toString('hex'); }

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const sess = sessions.get(token);
  if (!sess) return res.status(401).json({ error: 'Not authenticated' });
  req.session = sess;
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.session.role)) return res.status(403).json({ error: 'Forbidden for this role' });
    next();
  };
}

/* ---------------- realtime helper ---------------- */
// Broadcasts to everyone; frontend filters by relevance. Simple & reliable for this scale.
function broadcast(event, payload) {
  io.emit(event, payload);
}
function notify(audience, message) {
  const n = { id: 'N-' + Date.now() + '-' + Math.floor(Math.random() * 999), audience, message, createdAt: new Date().toISOString(), read: 0 };
  db.prepare('INSERT INTO notifications (id,audience,message,createdAt,read) VALUES (?,?,?,?,0)')
    .run(n.id, n.audience, n.message, n.createdAt);
  broadcast('notification', n);
}

/* ================= AUTH ================= */
// Accepts either the assigned ID or the account's full name as the identifier,
// per "login using ID or full name" — password (or, for patients, phone) still required.
function findAccount(table, identifier, password, extraPasswordCol) {
  const byId = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(identifier);
  const row = byId || db.prepare(`SELECT * FROM ${table} WHERE LOWER(name)=LOWER(?)`).get(identifier);
  if (!row) return null;
  const passOk = row.password === password || (extraPasswordCol && row[extraPasswordCol] === password);
  return passOk ? row : null;
}
app.post('/api/login', (req, res) => {
  const { role, id, password } = req.body;
  let row = null;
  if (role === 'admin') row = findAccount('admins', id, password);
  else if (role === 'doctor') row = findAccount('doctors', id, password);
  else if (role === 'nurse') row = findAccount('nurses', id, password);
  else if (role === 'patient') row = findAccount('patients', id, password, 'phone');
  else return res.status(400).json({ error: 'Unknown role' });

  if (!row) return res.status(401).json({ error: 'Invalid ID/name or password' });

  const token = newToken();
  sessions.set(token, { role, id: row.id, hospitalId: row.hospitalId || null });
  const { password: _pw, ...safe } = row;
  res.json({ token, role, user: safe });
});

app.post('/api/logout', auth, (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  sessions.delete(token);
  res.json({ ok: true });
});

// Universal self-service profile edit — every role can update their own photo,
// address, and password. Nothing else (name/ID/clinical fields stay admin- or
// doctor-controlled per role, as already enforced on the dedicated routes below).
app.put('/api/me', auth, (req, res) => {
  const s = req.session;
  const table = { admin: 'admins', doctor: 'doctors', nurse: 'nurses', patient: 'patients' }[s.role];
  const allowed = ['photo', 'address', 'password'];
  const fields = {};
  for (const k of allowed) if (k in req.body && req.body[k] !== '') fields[k] = req.body[k];
  const keys = Object.keys(fields);
  if (keys.length) db.prepare(`UPDATE ${table} SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k => fields[k]), s.id);
  const { password: _pw, ...safe } = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(s.id);
  res.json({ ok: true, user: safe });
});

/* ================= HOSPITALS ================= */
app.get('/api/hospitals/public', (req, res) => {
  res.json(db.prepare('SELECT id,name,city,address,latitude,longitude FROM hospitals').all());
});
app.get('/api/hospitals', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM hospitals').all());
});
app.post('/api/hospitals', auth, requireRole('admin'), (req, res) => {
  const { name, city, address, latitude, longitude } = req.body;
  const id = 'H-' + (db.prepare('SELECT COUNT(*) c FROM hospitals').get().c + 1);
  db.prepare('INSERT INTO hospitals (id,name,city,address,latitude,longitude) VALUES (?,?,?,?,?,?)')
    .run(id, name, city || '', address || '', latitude ?? null, longitude ?? null);
  db.prepare('INSERT INTO beds (hospitalId,total,occupied) VALUES (?,0,0)').run(id);
  const groups = ['A+','A-','B+','B-','AB+','AB-','O+','O-'];
  const insBlood = db.prepare('INSERT INTO blood_bank (id,hospitalId,bloodGroup,units) VALUES (?,?,?,0)');
  groups.forEach(g => insBlood.run(`BB-${id}-${g}`, id, g));
  notify('admin', `Hospital "${name}" added to the network.`);
  broadcast('hospitals:changed', {});
  res.json({ id });
});
app.put('/api/hospitals/:id', auth, requireRole('admin'), (req, res) => {
  const allowed = ['name', 'city', 'address', 'latitude', 'longitude'];
  const fields = {};
  for (const k of allowed) if (k in req.body) fields[k] = req.body[k];
  const keys = Object.keys(fields);
  if (keys.length) db.prepare(`UPDATE hospitals SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k => fields[k]), req.params.id);
  broadcast('hospitals:changed', {});
  res.json({ ok: true });
});

/* ================= STAFF DIRECTORY (admin manages doctors & nurses) ================= */
app.get('/api/staff', auth, requireRole('admin', 'nurse'), (req, res) => {
  const doctors = db.prepare('SELECT id,name,hospitalId,specialty FROM doctors').all();
  const nurses = db.prepare('SELECT id,name,hospitalId FROM nurses').all();
  res.json({ doctors, nurses });
});
app.post('/api/staff/doctor', auth, requireRole('admin'), (req, res) => {
  const { name, hospitalId, password, specialty } = req.body;
  const id = 'DR-' + (1000 + db.prepare('SELECT COUNT(*) c FROM doctors').get().c + 1);
  db.prepare('INSERT INTO doctors (id,name,hospitalId,password,specialty) VALUES (?,?,?,?,?)')
    .run(id, name, hospitalId, password, specialty || '');
  notify('admin', `Doctor account created for ${name} (${id}).`);
  broadcast('staff:changed', {});
  res.json({ id });
});
app.post('/api/staff/nurse', auth, requireRole('admin'), (req, res) => {
  const { name, hospitalId, password } = req.body;
  const id = 'NR-' + (1000 + db.prepare('SELECT COUNT(*) c FROM nurses').get().c + 1);
  db.prepare('INSERT INTO nurses (id,name,hospitalId,password) VALUES (?,?,?,?)').run(id, name, hospitalId, password);
  notify('admin', `Nurse account created for ${name} (${id}).`);
  broadcast('staff:changed', {});
  res.json({ id });
});
app.put('/api/staff/:role/:id', auth, requireRole('admin'), (req, res) => {
  const { role, id } = req.params;
  const table = role === 'doctor' ? 'doctors' : 'nurses';
  const fields = req.body; // {name?, password?, hospitalId?, specialty?}
  const keys = Object.keys(fields);
  if (!keys.length) return res.json({ ok: true });
  db.prepare(`UPDATE ${table} SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k => fields[k]), id);
  broadcast('staff:changed', {});
  res.json({ ok: true });
});
app.delete('/api/staff/:role/:id', auth, requireRole('admin'), (req, res) => {
  const { role, id } = req.params;
  const table = role === 'doctor' ? 'doctors' : 'nurses';
  db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
  notify('admin', `${role} account ${id} removed.`);
  broadcast('staff:changed', {});
  res.json({ ok: true });
});

/* ================= PATIENTS ================= */
// Admin: all patients, full CRUD. Doctor: only own patients. Nurse: all patients in own hospital. Patient: only self.
app.get('/api/patients', auth, (req, res) => {
  const s = req.session;
  let rows;
  if (s.role === 'admin') rows = db.prepare('SELECT * FROM patients').all();
  else if (s.role === 'doctor') rows = db.prepare('SELECT * FROM patients WHERE doctorId=?').all(s.id);
  else if (s.role === 'nurse') rows = db.prepare('SELECT * FROM patients WHERE hospitalId=?').all(s.hospitalId);
  else rows = db.prepare('SELECT * FROM patients WHERE id=?').all(s.id);
  res.json(rows.map(({ password, ...rest }) => rest));
});
app.post('/api/patients', auth, requireRole('admin'), (req, res) => {
  const { name, age, dept, diagnosis, status, hospitalId, doctorId, password, insurance, cost, gender, bloodGroup, contactNumber, emergencyContact } = req.body;
  const id = 'PT-' + String(db.prepare('SELECT COUNT(*) c FROM patients').get().c + 1).padStart(3, '0');
  db.prepare(`INSERT INTO patients (id,name,age,dept,diagnosis,status,hospitalId,doctorId,password,insurance,cost,gender,bloodGroup,contactNumber,emergencyContact)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, name, age, dept, diagnosis, status || 'stable', hospitalId, doctorId, password, insurance || '', cost || 0, gender || '', bloodGroup || '', contactNumber || '', emergencyContact || '');
  notify('admin', `Patient ${name} (${id}) added with portal access.`);
  notify(`doctor:${doctorId}`, `New patient ${name} (${id}) assigned to you.`);
  broadcast('patients:changed', {});
  res.json({ id });
});
// Public: patient self-registration from the login screen (no admin needed).
// Leaving Patient ID blank on the login form hits this route; the phone number
// doubles as the patient's login credential from then on.
app.post('/api/patients/self-register', (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Full name and phone number are required' });
  const hosp = db.prepare('SELECT id FROM hospitals LIMIT 1').get();
  if (!hosp) return res.status(500).json({ error: 'No hospital available to register under' });

  const id = 'PT-' + String(db.prepare('SELECT COUNT(*) c FROM patients').get().c + 1).padStart(3, '0');
  db.prepare(`INSERT INTO patients (id,name,age,dept,diagnosis,status,hospitalId,doctorId,password,insurance,cost,phone)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, name, null, null, null, 'stable', hosp.id, null, phone, '', 0, phone);
  notify('admin', `Patient ${name} (${id}) self-registered via the portal.`);
  broadcast('patients:changed', {});

  const token = newToken();
  sessions.set(token, { role: 'patient', id, hospitalId: hosp.id });
  const { password: _pw, ...safe } = db.prepare('SELECT * FROM patients WHERE id=?').get(id);
  res.json({ token, role: 'patient', user: safe });
});

app.put('/api/patients/:id', auth, requireRole('admin', 'nurse', 'doctor'), (req, res) => {
  const { id } = req.params;
  const s = req.session;
  const patient = db.prepare('SELECT * FROM patients WHERE id=?').get(id);
  if (!patient) return res.status(404).json({ error: 'Not found' });
  if (s.role === 'doctor' && patient.doctorId !== s.id) return res.status(403).json({ error: 'Not your patient' });
  if (s.role === 'nurse' && patient.hospitalId !== s.hospitalId) return res.status(403).json({ error: 'Different hospital' });

  const allowed = s.role === 'admin'
    ? ['name', 'age', 'dept', 'diagnosis', 'status', 'hospitalId', 'doctorId', 'password', 'insurance', 'cost', 'report', 'gender', 'bloodGroup', 'contactNumber', 'emergencyContact', 'photo', 'address']
    : ['status', 'diagnosis']; // doctor/nurse can only update clinical fields; everything else is admin-only
  const fields = {};
  for (const k of allowed) if (k in req.body) fields[k] = req.body[k];
  const keys = Object.keys(fields);
  if (keys.length) {
    db.prepare(`UPDATE patients SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k => fields[k]), id);
  }
  notify(`patient:${id}`, `Your record was updated by ${s.role} ${s.id}.`);
  broadcast('patients:changed', {});
  res.json({ ok: true });
});
app.delete('/api/patients/:id', auth, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM patients WHERE id=?').run(req.params.id);
  notify('admin', `Patient record ${req.params.id} removed.`);
  broadcast('patients:changed', {});
  res.json({ ok: true });
});

/* ================= EQUIPMENT / EMERGENCY READINESS ================= */
app.get('/api/equipment', auth, (req, res) => {
  const s = req.session;
  let hospitalId = req.query.hospitalId;
  if (s.role === 'nurse' || s.role === 'doctor') hospitalId = s.hospitalId;
  const rows = hospitalId
    ? db.prepare('SELECT * FROM equipment WHERE hospitalId=?').all(hospitalId)
    : db.prepare('SELECT * FROM equipment').all();
  res.json(rows);
});
app.put('/api/equipment/:id', auth, requireRole('admin', 'nurse'), (req, res) => {
  const { available, total } = req.body;
  const fields = {};
  if (available !== undefined) fields.available = available;
  if (total !== undefined) fields.total = total;
  const keys = Object.keys(fields);
  if (keys.length) db.prepare(`UPDATE equipment SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k => fields[k]), req.params.id);
  broadcast('equipment:changed', {});
  res.json({ ok: true });
});

app.get('/api/beds', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM beds').all());
});
app.put('/api/beds/:hospitalId', auth, requireRole('admin', 'nurse'), (req, res) => {
  const { occupied, total } = req.body;
  const fields = {};
  if (occupied !== undefined) fields.occupied = occupied;
  if (total !== undefined) fields.total = total;
  const keys = Object.keys(fields);
  if (keys.length) db.prepare(`UPDATE beds SET ${keys.map(k => `${k}=?`).join(',')} WHERE hospitalId=?`).run(...keys.map(k => fields[k]), req.params.hospitalId);
  broadcast('beds:changed', {});
  res.json({ ok: true });
});

/* ================= BLOOD AVAILABILITY ================= */
app.get('/api/blood', auth, (req, res) => {
  const s = req.session;
  let hospitalId = req.query.hospitalId;
  if (s.role === 'nurse' || s.role === 'doctor') hospitalId = s.hospitalId;
  const rows = hospitalId
    ? db.prepare('SELECT * FROM blood_bank WHERE hospitalId=?').all(hospitalId)
    : db.prepare('SELECT * FROM blood_bank').all();
  res.json(rows);
});
// Public read — patients and unauthenticated visitors (e.g. from the SOS flow) can check availability before a login.
app.get('/api/blood/public', (req, res) => {
  const rows = db.prepare('SELECT hospitalId,bloodGroup,units FROM blood_bank').all();
  res.json(rows);
});
app.put('/api/blood/:id', auth, requireRole('admin', 'nurse'), (req, res) => {
  const { units } = req.body;
  db.prepare('UPDATE blood_bank SET units=? WHERE id=?').run(units, req.params.id);
  const row = db.prepare('SELECT * FROM blood_bank WHERE id=?').get(req.params.id);
  if (row && row.units <= 3) notify('admin', `Low blood stock: ${row.bloodGroup} at ${row.hospitalId} down to ${row.units} units.`);
  broadcast('blood:changed', {});
  res.json({ ok: true });
});

/* ================= ORGAN DONATION ================= */
app.get('/api/organs', auth, (req, res) => {
  const s = req.session;
  let hospitalId = req.query.hospitalId;
  if (s.role === 'nurse' || s.role === 'doctor') hospitalId = s.hospitalId;
  const rows = hospitalId
    ? db.prepare('SELECT * FROM organ_bank WHERE hospitalId=?').all(hospitalId)
    : db.prepare('SELECT * FROM organ_bank').all();
  res.json(rows);
});
// Public read — same rationale as /api/blood/public: visible before login.
app.get('/api/organs/public', (req, res) => {
  const rows = db.prepare('SELECT hospitalId,organ,required,pledged FROM organ_bank').all();
  res.json(rows);
});
// Only Hospital Admin (and nurses, who run the ward-level waitlist day to day) can set
// how many organs a hospital requires or how many pledges it currently has.
app.put('/api/organs/:id', auth, requireRole('admin', 'nurse'), (req, res) => {
  const row = db.prepare('SELECT * FROM organ_bank WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const required = 'required' in req.body ? +req.body.required : row.required;
  const pledged = 'pledged' in req.body ? +req.body.pledged : row.pledged;
  db.prepare('UPDATE organ_bank SET required=?, pledged=? WHERE id=?').run(required, pledged, req.params.id);
  if (required > pledged) notify('admin', `Organ shortfall: ${row.organ} at ${row.hospitalId} needs ${required - pledged} more pledge(s).`);
  broadcast('organs:changed', {});
  res.json({ ok: true });
});

// Patient self-service: register/withdraw as an organ donor. Only the logged-in
// patient can flip their own pledge — not an admin/nurse/doctor editing someone else.
app.put('/api/patients/:id/donor-pledge', auth, requireRole('patient'), (req, res) => {
  const s = req.session;
  if (s.id !== req.params.id) return res.status(403).json({ error: 'You can only update your own donor status' });
  const isDonor = req.body.isDonor ? 1 : 0;
  db.prepare('UPDATE patients SET isDonor=? WHERE id=?').run(isDonor, req.params.id);
  broadcast('patients:changed', {});
  res.json({ ok: true, isDonor: !!isDonor });
});

/* ================= APPOINTMENTS ================= */
app.get('/api/appointments', auth, (req, res) => {
  const s = req.session;
  let rows;
  if (s.role === 'admin') rows = db.prepare('SELECT * FROM appointments').all();
  else if (s.role === 'doctor') rows = db.prepare('SELECT * FROM appointments WHERE doctorId=?').all(s.id);
  else if (s.role === 'nurse') rows = db.prepare('SELECT * FROM appointments WHERE hospitalId=?').all(s.hospitalId);
  else rows = db.prepare('SELECT * FROM appointments WHERE patientId=?').all(s.id);
  res.json(rows);
});
app.post('/api/appointments', auth, (req, res) => {
  const s = req.session;
  let { patientId, doctorId, hospitalId, date, reason } = req.body;
  if (s.role === 'patient') patientId = s.id; // patients may only book for themselves
  if (s.role === 'nurse') hospitalId = s.hospitalId; // nurse may only add for own hospital
  const id = 'AP-' + Date.now();
  db.prepare('INSERT INTO appointments (id,patientId,doctorId,hospitalId,date,reason,status) VALUES (?,?,?,?,?,?,?)')
    .run(id, patientId, doctorId || null, hospitalId, date, reason || '', 'pending');
  if (doctorId) notify(`doctor:${doctorId}`, `New appointment request from ${patientId} on ${date}.`);
  notify(`patient:${patientId}`, `Appointment requested for ${date}.`);
  broadcast('appointments:changed', {});
  res.json({ id });
});
app.put('/api/appointments/:id', auth, requireRole('admin', 'doctor', 'nurse'), (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE appointments SET status=? WHERE id=?').run(status, req.params.id);
  const appt = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id);
  if (appt) notify(`patient:${appt.patientId}`, `Your appointment on ${appt.date} is now "${status}".`);
  broadcast('appointments:changed', {});
  res.json({ ok: true });
});

/* ================= NOTIFICATIONS ================= */
app.get('/api/notifications', auth, (req, res) => {
  const s = req.session;
  const mine = [`${s.role}:${s.id}`, s.role, s.hospitalId ? `hospital:${s.hospitalId}` : null].filter(Boolean);
  const placeholders = mine.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM notifications WHERE audience IN (${placeholders}) ORDER BY createdAt DESC LIMIT 50`).all(...mine);
  res.json(rows);
});

/* ================= SOS (public — no login required) ================= */
app.post('/api/sos', (req, res) => {
  const { name, phone, reason, hospitalId, latitude, longitude } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number is required so responders can reach you' });
  const id = 'SOS-' + Date.now();
  db.prepare(`INSERT INTO sos_alerts (id,name,phone,reason,hospitalId,latitude,longitude,createdAt,status)
    VALUES (?,?,?,?,?,?,?,?,'open')`)
    .run(id, name || 'Unknown', phone, reason || '', hospitalId || null, latitude ?? null, longitude ?? null, new Date().toISOString());
  const msg = `SOS from ${name || 'an unidentified caller'} (${phone})${reason ? ' — ' + reason : ''}.`;
  notify('admin', msg);
  if (hospitalId) notify(`hospital:${hospitalId}`, msg);
  broadcast('sos', { id, name, phone, reason, hospitalId, latitude, longitude, createdAt: new Date().toISOString() });
  res.json({ id, ok: true });
});
app.get('/api/sos', auth, requireRole('admin', 'nurse'), (req, res) => {
  res.json(db.prepare('SELECT * FROM sos_alerts ORDER BY createdAt DESC LIMIT 100').all());
});
app.put('/api/sos/:id', auth, requireRole('admin', 'nurse'), (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE sos_alerts SET status=? WHERE id=?').run(status, req.params.id);
  broadcast('sos:changed', {});
  res.json({ ok: true });
});

/* ================= HEALTH RECORDS (doctor writes, own patients only) ================= */
function canTouchPatientRecord(s, patientId) {
  const patient = db.prepare('SELECT * FROM patients WHERE id=?').get(patientId);
  if (!patient) return { ok: false, code: 404, error: 'Patient not found' };
  if (s.role === 'doctor' && patient.doctorId !== s.id) return { ok: false, code: 403, error: 'Not your patient' };
  if (s.role === 'patient' && s.id !== patientId) return { ok: false, code: 403, error: 'Not your record' };
  return { ok: true, patient };
}
app.get('/api/health-records', auth, (req, res) => {
  const s = req.session;
  const patientId = req.query.patientId || (s.role === 'patient' ? s.id : null);
  if (!patientId) return res.status(400).json({ error: 'patientId required' });
  const check = canTouchPatientRecord(s, patientId);
  if (!check.ok) return res.status(check.code).json({ error: check.error });
  res.json(db.prepare('SELECT * FROM health_records WHERE patientId=? ORDER BY createdAt DESC').all(patientId));
});
app.post('/api/health-records', auth, requireRole('doctor'), (req, res) => {
  const s = req.session;
  const { patientId, note } = req.body;
  if (!note) return res.status(400).json({ error: 'Note is required' });
  const check = canTouchPatientRecord(s, patientId);
  if (!check.ok) return res.status(check.code).json({ error: check.error });
  const id = 'HR-' + Date.now();
  db.prepare('INSERT INTO health_records (id,patientId,doctorId,note,createdAt) VALUES (?,?,?,?,?)')
    .run(id, patientId, s.id, note, new Date().toISOString());
  notify(`patient:${patientId}`, `Your doctor added a new health record entry.`);
  broadcast('health-records:changed', {});
  res.json({ id });
});
app.delete('/api/health-records/:id', auth, requireRole('doctor'), (req, res) => {
  const row = db.prepare('SELECT * FROM health_records WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.doctorId !== req.session.id) return res.status(403).json({ error: 'Only the doctor who wrote this entry can remove it' });
  db.prepare('DELETE FROM health_records WHERE id=?').run(req.params.id);
  broadcast('health-records:changed', {});
  res.json({ ok: true });
});

/* ================= DIET PLAN (one per patient, doctor-owned) ================= */
app.get('/api/diet-plan/:patientId', auth, (req, res) => {
  const check = canTouchPatientRecord(req.session, req.params.patientId);
  if (!check.ok) return res.status(check.code).json({ error: check.error });
  const row = db.prepare('SELECT * FROM diet_plans WHERE patientId=?').get(req.params.patientId);
  res.json(row || { patientId: req.params.patientId, text: '', doctorId: null, updatedAt: null });
});
app.put('/api/diet-plan/:patientId', auth, requireRole('doctor'), (req, res) => {
  const s = req.session;
  const check = canTouchPatientRecord(s, req.params.patientId);
  if (!check.ok) return res.status(check.code).json({ error: check.error });
  const { text } = req.body;
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM diet_plans WHERE patientId=?').get(req.params.patientId);
  if (existing) db.prepare('UPDATE diet_plans SET text=?, doctorId=?, updatedAt=? WHERE patientId=?').run(text || '', s.id, now, req.params.patientId);
  else db.prepare('INSERT INTO diet_plans (patientId,doctorId,text,updatedAt) VALUES (?,?,?,?)').run(req.params.patientId, s.id, text || '', now);
  notify(`patient:${req.params.patientId}`, `Your diet plan was updated.`);
  broadcast('diet:changed', {});
  res.json({ ok: true });
});

/* ================= MEDICINES (prescribed by, and editable only by, the owning doctor) ================= */
app.get('/api/medicines', auth, (req, res) => {
  const s = req.session;
  const patientId = req.query.patientId || (s.role === 'patient' ? s.id : null);
  if (!patientId) return res.status(400).json({ error: 'patientId required' });
  const check = canTouchPatientRecord(s, patientId);
  if (!check.ok) return res.status(check.code).json({ error: check.error });
  res.json(db.prepare('SELECT * FROM medicines WHERE patientId=? ORDER BY createdAt DESC').all(patientId));
});
app.post('/api/medicines', auth, requireRole('doctor'), (req, res) => {
  const s = req.session;
  const { patientId, name, dosage, instructions } = req.body;
  if (!name) return res.status(400).json({ error: 'Medicine name is required' });
  const check = canTouchPatientRecord(s, patientId);
  if (!check.ok) return res.status(check.code).json({ error: check.error });
  const id = 'MED-' + Date.now();
  db.prepare('INSERT INTO medicines (id,patientId,doctorId,name,dosage,instructions,createdAt) VALUES (?,?,?,?,?,?,?)')
    .run(id, patientId, s.id, name, dosage || '', instructions || '', new Date().toISOString());
  notify(`patient:${patientId}`, `Your doctor prescribed ${name}.`);
  broadcast('medicines:changed', {});
  res.json({ id });
});
app.delete('/api/medicines/:id', auth, requireRole('doctor'), (req, res) => {
  const row = db.prepare('SELECT * FROM medicines WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.doctorId !== req.session.id) return res.status(403).json({ error: 'Only the prescribing doctor can remove this' });
  db.prepare('DELETE FROM medicines WHERE id=?').run(req.params.id);
  broadcast('medicines:changed', {});
  res.json({ ok: true });
});

/* ================= AMBULANCES (admin CRUD, own hospital; everyone else reads) ================= */
app.get('/api/ambulances', auth, (req, res) => {
  const s = req.session;
  let hospitalId = req.query.hospitalId;
  if (s.role === 'nurse' || s.role === 'doctor') hospitalId = s.hospitalId;
  const rows = hospitalId
    ? db.prepare('SELECT * FROM ambulances WHERE hospitalId=?').all(hospitalId)
    : db.prepare('SELECT * FROM ambulances').all();
  res.json(rows);
});
app.post('/api/ambulances', auth, requireRole('admin'), (req, res) => {
  const { hospitalId, vehicleNo, driverName, contact, status } = req.body;
  if (!hospitalId || !vehicleNo) return res.status(400).json({ error: 'Hospital and vehicle number are required' });
  const id = 'AMB-' + Date.now();
  db.prepare('INSERT INTO ambulances (id,hospitalId,vehicleNo,driverName,contact,status) VALUES (?,?,?,?,?,?)')
    .run(id, hospitalId, vehicleNo, driverName || '', contact || '', status || 'available');
  broadcast('ambulances:changed', {});
  res.json({ id });
});
app.put('/api/ambulances/:id', auth, requireRole('admin'), (req, res) => {
  const allowed = ['vehicleNo', 'driverName', 'contact', 'status'];
  const fields = {};
  for (const k of allowed) if (k in req.body) fields[k] = req.body[k];
  const keys = Object.keys(fields);
  if (keys.length) db.prepare(`UPDATE ambulances SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k => fields[k]), req.params.id);
  broadcast('ambulances:changed', {});
  res.json({ ok: true });
});
app.delete('/api/ambulances/:id', auth, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM ambulances WHERE id=?').run(req.params.id);
  broadcast('ambulances:changed', {});
  res.json({ ok: true });
});

/* ================= DISEASES (admin CRUD; everyone else reads) ================= */
app.get('/api/diseases', auth, (req, res) => {
  const s = req.session;
  let hospitalId = req.query.hospitalId;
  if (s.role === 'nurse' || s.role === 'doctor') hospitalId = s.hospitalId;
  const rows = hospitalId
    ? db.prepare('SELECT * FROM diseases WHERE hospitalId=?').all(hospitalId)
    : db.prepare('SELECT * FROM diseases').all();
  res.json(rows);
});
app.post('/api/diseases', auth, requireRole('admin'), (req, res) => {
  const { hospitalId, name, notes } = req.body;
  if (!hospitalId || !name) return res.status(400).json({ error: 'Hospital and disease name are required' });
  const id = 'DIS-' + Date.now();
  db.prepare('INSERT INTO diseases (id,hospitalId,name,notes) VALUES (?,?,?,?)').run(id, hospitalId, name, notes || '');
  broadcast('diseases:changed', {});
  res.json({ id });
});
app.delete('/api/diseases/:id', auth, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM diseases WHERE id=?').run(req.params.id);
  broadcast('diseases:changed', {});
  res.json({ ok: true });
});

/* ================= HEALTH ================= */
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

io.on('connection', (socket) => {
  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Medi+ Command backend running on http://localhost:${PORT}`));
