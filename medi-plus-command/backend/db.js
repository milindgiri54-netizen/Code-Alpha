const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'medi-plus.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS hospitals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT,
  address TEXT,
  latitude REAL,
  longitude REAL
);

CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  password TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS doctors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hospitalId TEXT NOT NULL,
  password TEXT NOT NULL,
  specialty TEXT
);

CREATE TABLE IF NOT EXISTS nurses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hospitalId TEXT NOT NULL,
  password TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  age INTEGER,
  dept TEXT,
  diagnosis TEXT,
  status TEXT DEFAULT 'stable',
  hospitalId TEXT NOT NULL,
  doctorId TEXT,
  password TEXT NOT NULL,
  insurance TEXT,
  cost REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS equipment (
  id TEXT PRIMARY KEY,
  hospitalId TEXT NOT NULL,
  name TEXT NOT NULL,
  total INTEGER DEFAULT 0,
  available INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS beds (
  hospitalId TEXT PRIMARY KEY,
  total INTEGER DEFAULT 0,
  occupied INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS blood_bank (
  id TEXT PRIMARY KEY,
  hospitalId TEXT NOT NULL,
  bloodGroup TEXT NOT NULL,
  units INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS organ_bank (
  id TEXT PRIMARY KEY,
  hospitalId TEXT NOT NULL,
  organ TEXT NOT NULL,
  required INTEGER DEFAULT 0,
  pledged INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  patientId TEXT NOT NULL,
  doctorId TEXT,
  hospitalId TEXT NOT NULL,
  date TEXT NOT NULL,
  reason TEXT,
  status TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  audience TEXT NOT NULL,          -- 'admin' | 'doctor:<id>' | 'nurse:<id>' | 'patient:<id>' | 'hospital:<id>'
  message TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  read INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sos_alerts (
  id TEXT PRIMARY KEY,
  name TEXT,
  phone TEXT,
  reason TEXT,
  hospitalId TEXT,
  latitude REAL,
  longitude REAL,
  createdAt TEXT NOT NULL,
  status TEXT DEFAULT 'open'
);

-- Doctor writes, patient reads: freeform progress notes on a patient's chart.
-- Only the doctor who owns the patient may add/remove entries (enforced in server.js).
CREATE TABLE IF NOT EXISTS health_records (
  id TEXT PRIMARY KEY,
  patientId TEXT NOT NULL,
  doctorId TEXT NOT NULL,
  note TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

-- One diet plan per patient, editable only by their assigned doctor.
CREATE TABLE IF NOT EXISTS diet_plans (
  patientId TEXT PRIMARY KEY,
  doctorId TEXT NOT NULL,
  text TEXT,
  updatedAt TEXT
);

-- Prescribed medicines, editable only by the doctor who prescribed them.
CREATE TABLE IF NOT EXISTS medicines (
  id TEXT PRIMARY KEY,
  patientId TEXT NOT NULL,
  doctorId TEXT NOT NULL,
  name TEXT NOT NULL,
  dosage TEXT,
  instructions TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ambulances (
  id TEXT PRIMARY KEY,
  hospitalId TEXT NOT NULL,
  vehicleNo TEXT NOT NULL,
  driverName TEXT,
  contact TEXT,
  status TEXT DEFAULT 'available'  -- 'available' | 'on-duty'
);

CREATE TABLE IF NOT EXISTS diseases (
  id TEXT PRIMARY KEY,
  hospitalId TEXT NOT NULL,
  name TEXT NOT NULL,
  notes TEXT
);
`);

// ---- migrations: additive columns for older DB files ----
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('patients', 'phone', 'phone TEXT');
ensureColumn('patients', 'report', 'report TEXT');
ensureColumn('patients', 'isDonor', 'isDonor INTEGER DEFAULT 0');
ensureColumn('patients', 'gender', 'gender TEXT');
ensureColumn('patients', 'bloodGroup', 'bloodGroup TEXT');
ensureColumn('patients', 'photo', 'photo TEXT');
ensureColumn('patients', 'contactNumber', 'contactNumber TEXT');
ensureColumn('patients', 'emergencyContact', 'emergencyContact TEXT');
ensureColumn('patients', 'address', 'address TEXT');
ensureColumn('admins', 'photo', 'photo TEXT');
ensureColumn('admins', 'address', 'address TEXT');
ensureColumn('doctors', 'photo', 'photo TEXT');
ensureColumn('doctors', 'address', 'address TEXT');
ensureColumn('nurses', 'photo', 'photo TEXT');
ensureColumn('nurses', 'address', 'address TEXT');

function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) c FROM hospitals').get().c;
  if (count > 0) return;

  const insHosp = db.prepare('INSERT INTO hospitals (id,name,city,address,latitude,longitude) VALUES (?,?,?,?,?,?)');
  insHosp.run('H-1', 'Metro General Hospital', 'Nagpur', 'Civil Lines, Nagpur, Maharashtra', 21.1498, 79.0821);
  insHosp.run('H-2', 'Riverside Medical Center', 'Nagpur', 'Sitabuldi, Nagpur, Maharashtra', 21.1466, 79.0882);

  db.prepare('INSERT INTO admins (id,name,password) VALUES (?,?,?)')
    .run('ADM-1001', 'Hospital Admin', 'admin123');

  const insDoc = db.prepare('INSERT INTO doctors (id,name,hospitalId,password,specialty) VALUES (?,?,?,?,?)');
  insDoc.run('DR-1001', 'Dr. Asha Verma', 'H-1', 'doc123', 'Cardiology');
  insDoc.run('DR-1002', 'Dr. Karan Mehta', 'H-2', 'doc123', 'Orthopedics');

  const insNur = db.prepare('INSERT INTO nurses (id,name,hospitalId,password) VALUES (?,?,?,?)');
  insNur.run('NR-1001', 'Nurse Priya Rao', 'H-1', 'nurse123');

  const insPat = db.prepare(`INSERT INTO patients (id,name,age,dept,diagnosis,status,hospitalId,doctorId,password,insurance,cost,gender,bloodGroup,contactNumber,emergencyContact)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insPat.run('PT-001', 'Rohan Sharma', 34, 'Cardiology', 'Hypertension', 'stable', 'H-1', 'DR-1001', 'pat123', 'StarHealth', 12500, 'Male', 'B+', '9820012345', 'Sunita Sharma: 9820098765');
  insPat.run('PT-002', 'Meera Iyer', 58, 'Orthopedics', 'Fracture - left tibia', 'moderate', 'H-2', 'DR-1002', 'pat123', 'ICICI Lombard', 34000, 'Female', 'O+', '9765043210', 'Anand Iyer: 9765011111');

  const insEq = db.prepare('INSERT INTO equipment (id,hospitalId,name,total,available) VALUES (?,?,?,?,?)');
  insEq.run('EQ-1', 'H-1', 'Ventilators', 20, 14);
  insEq.run('EQ-2', 'H-1', 'ICU Monitors', 30, 22);
  insEq.run('EQ-3', 'H-2', 'Ventilators', 15, 9);

  db.prepare('INSERT INTO beds (hospitalId,total,occupied) VALUES (?,?,?)').run('H-1', 120, 87);
  db.prepare('INSERT INTO beds (hospitalId,total,occupied) VALUES (?,?,?)').run('H-2', 90, 41);

  const insBlood = db.prepare('INSERT INTO blood_bank (id,hospitalId,bloodGroup,units) VALUES (?,?,?,?)');
  const groups = ['A+','A-','B+','B-','AB+','AB-','O+','O-'];
  const startsH1 = [12,4,9,3,6,2,20,7];
  const startsH2 = [8,2,6,1,3,1,14,4];
  groups.forEach((g,i) => insBlood.run(`BB-H1-${g}`, 'H-1', g, startsH1[i]));
  groups.forEach((g,i) => insBlood.run(`BB-H2-${g}`, 'H-2', g, startsH2[i]));

  const insOrgan = db.prepare('INSERT INTO organ_bank (id,hospitalId,organ,required,pledged) VALUES (?,?,?,?,?)');
  const organs = ['Kidney','Liver','Heart','Lungs','Cornea','Pancreas'];
  const reqH1 = [5, 3, 2, 2, 6, 1];
  const pledgedH1 = [2, 1, 0, 1, 4, 0];
  const reqH2 = [3, 2, 1, 1, 4, 1];
  const pledgedH2 = [1, 0, 0, 0, 2, 0];
  organs.forEach((o,i) => insOrgan.run(`OB-H1-${o}`, 'H-1', o, reqH1[i], pledgedH1[i]));
  organs.forEach((o,i) => insOrgan.run(`OB-H2-${o}`, 'H-2', o, reqH2[i], pledgedH2[i]));

  const insAmb = db.prepare('INSERT INTO ambulances (id,hospitalId,vehicleNo,driverName,contact,status) VALUES (?,?,?,?,?,?)');
  insAmb.run('AMB-1', 'H-1', 'MH-31-AB-1234', 'Suresh Pawar', '9822011111', 'available');
  insAmb.run('AMB-2', 'H-1', 'MH-31-AB-5678', 'Ramesh Kale', '9822022222', 'on-duty');
  insAmb.run('AMB-3', 'H-2', 'MH-31-CD-4321', 'Vikas Deshmukh', '9822033333', 'available');

  const insDis = db.prepare('INSERT INTO diseases (id,hospitalId,name,notes) VALUES (?,?,?,?)');
  insDis.run('DIS-1', 'H-1', 'Hypertension', 'Common in cardiology ward, monitored with routine BP checks.');
  insDis.run('DIS-2', 'H-1', 'Type 2 Diabetes', 'Managed via diet plans and periodic glucose monitoring.');
  insDis.run('DIS-3', 'H-2', 'Fractures', 'Most frequent in orthopedics; average recovery tracked per case.');
}
seedIfEmpty();

// Migration: existing DBs (created before organ donation tracking existed) already
// have hospitals seeded, so seedIfEmpty() above is a no-op for them — backfill
// organ_bank rows for any hospital that doesn't have them yet.
function backfillOrganBank() {
  const organs = ['Kidney','Liver','Heart','Lungs','Cornea','Pancreas'];
  const hospitalsList = db.prepare('SELECT id FROM hospitals').all();
  for (const h of hospitalsList) {
    const has = db.prepare('SELECT COUNT(*) c FROM organ_bank WHERE hospitalId=?').get(h.id).c;
    if (has > 0) continue;
    const ins = db.prepare('INSERT INTO organ_bank (id,hospitalId,organ,required,pledged) VALUES (?,?,?,0,0)');
    organs.forEach(o => ins.run(`OB-${h.id}-${o}`, h.id, o));
  }
}
backfillOrganBank();

module.exports = db;
