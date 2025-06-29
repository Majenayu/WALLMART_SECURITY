const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://wal:wal@wal.ixnqgpx.mongodb.net/qr_items?retryWrites=true&w=majority&appName=Wal';

let db, mongoClient;

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [process.env.FRONTEND_URL, /\.render\.com$/, 'http://localhost:3000']
    : ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000', 'http://127.0.0.1:3001'],
  credentials: true
}));
app.use(express.static('.'));
app.use(express.json({ limit: '10mb' }));

const connectDB = async () => {
  if (mongoClient) try { await mongoClient.close(); } catch {}
  mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000, socketTimeoutMS: 30000, maxPoolSize: 10 });
  await mongoClient.connect();
  db = mongoClient.db('qr_items');
  await db.admin().ping();
  console.log('MongoDB connected');

  const idx = [
    ['security_watchmen', { name: 1 }, { unique: true }],
    ['security_watchmen', { securityId: 1 }, { unique: true }],
    ['security_watchmen', { contact: 1 }],
    ['security_assignments', { orderId: 1 }],
    ['security_assignments', { securityId: 1 }],
    ['security_assignments', { status: 1 }],
    ['security_assignments', { assignedAt: 1 }],
    ['security_stats', { securityId: 1 }, { unique: true }],
    ['orders', { orderId: 1 }],
    ['orders', { status: 1 }]
  ];
  await Promise.all(idx.map(([col, keys, opts]) => db.collection(col).createIndex(keys, opts)));
};

const checkDB = async (req, res, next) => {
  if (!db) try { await connectDB(); } catch { return res.status(500).json({ success: false, error: 'DB connect failed' }); }
  try { await db.admin().ping(); next(); } catch { try { await connectDB(); next(); } catch { res.status(500).json({ success: false, error: 'DB unavailable' }); } }
};

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/api/security/register', checkDB, async (req, res) => {
  const { name, contact, email } = req.body;
  if (!name || !contact || name.length < 2 || contact.length < 10)
    return res.status(400).json({ success: false, error: 'Invalid name or contact' });

  const nameLower = name.trim().toLowerCase();
  const existing = await db.collection('security_watchmen').findOne({ name: nameLower });
  if (existing)
    return res.status(400).json({ success: false, error: 'Name exists. Try logging in.' });

  const usedIds = (await db.collection('security_watchmen').find({}, { projection: { securityId: 1 } }).toArray()).map(w => +w.securityId);
  const availableId = ['1','2','3','4','5'].find(id => !usedIds.includes(+id));
  if (!availableId) return res.status(400).json({ success: false, error: 'Max 5 watchmen reached' });

  const newWatchman = { name: name.trim(), nameLower, contact: contact.trim(), email: email?.trim() || '', securityId: availableId, registeredAt: new Date(), status: 'active', createdAt: new Date(), lastLogin: null };
  await db.collection('security_watchmen').insertOne(newWatchman);
  await db.collection('security_stats').insertOne({ securityId: availableId, totalAssigned: 0, totalConfirmed: 0, totalExpired: 0, totalPending: 0, averageCompletionTime: 0, efficiency: 0, createdAt: new Date(), lastUpdated: new Date() });

  res.json({ success: true, message: 'Registered', securityId: availableId, watchman: { name: newWatchman.name, securityId: availableId, contact: newWatchman.contact, email: newWatchman.email } });
});

app.post('/api/security/login', checkDB, async (req, res) => {
  const { name } = req.body;
  if (!name || name.length < 2) return res.status(400).json({ success: false, error: 'Name is required' });

  const watchman = await db.collection('security_watchmen').findOne({ nameLower: name.trim().toLowerCase(), status: 'active' });
  if (!watchman) return res.status(404).json({ success: false, error: 'Watchman not found' });

  await db.collection('security_watchmen').updateOne({ _id: watchman._id }, { $set: { lastLogin: new Date(), updatedAt: new Date() } });
  res.json({ success: true, message: 'Login success', watchman: { name: watchman.name, securityId: watchman.securityId, contact: watchman.contact, email: watchman.email, registeredAt: watchman.registeredAt } });
});

app.get('/api/security/watchmen', checkDB, async (req, res) => {
  const watchmen = await db.collection('security_watchmen').find({ status: 'active' }, { projection: { name: 1, securityId: 1, contact: 1, email: 1, registeredAt: 1, lastLogin: 1 } }).sort({ securityId: 1 }).toArray();
  res.json({ success: true, watchmen });
});

app.get('/api/security/orders/:securityId', checkDB, async (req, res) => {
  const { securityId } = req.params;
  const validIds = ['1', '2', '3', '4', '5'];
  if (!validIds.includes(securityId)) return res.status(400).json({ success: false, error: 'Invalid ID' });

  const w = await db.collection('security_watchmen').findOne({ securityId, status: 'active' });
  if (!w) return res.status(404).json({ success: false, error: 'Watchman not found' });

  const assigned = await db.collection('security_assignments').find({ securityId, status: 'assigned', assignedAt: { $gte: new Date(Date.now() - 5 * 60000) } }).sort({ assignedAt: -1 }).limit(3).toArray();
  const orders = await Promise.all(assigned.map(async a => {
    const o = await db.collection('orders').findOne({ orderId: a.orderId });
    return o?.status === 'completed' ? { ...o, assignedAt: a.assignedAt, assignmentId: a._id } : null;
  }));
  res.json({ success: true, orders: orders.filter(Boolean) });
});

app.post('/api/security/confirm/:orderId', checkDB, async (req, res) => {
  const { orderId } = req.params, { securityId, watchmanName } = req.body;
  if (!orderId || !securityId || !watchmanName) return res.status(400).json({ success: false, error: 'Missing fields' });

  const w = await db.collection('security_watchmen').findOne({ securityId, status: 'active' });
  if (!w || w.nameLower !== watchmanName.trim().toLowerCase()) return res.status(403).json({ success: false, error: 'Watchman mismatch' });

  const a = await db.collection('security_assignments').findOne({ orderId, securityId, status: 'assigned' });
  if (!a) return res.status(404).json({ success: false, error: 'Assignment not found' });

  const elapsed = (Date.now() - new Date(a.assignedAt).getTime()) / 1000;
  if (elapsed > 300) {
    await db.collection('security_assignments').updateOne({ _id: a._id }, { $set: { status: 'expired', expiredAt: new Date() } });
    await reassignOrder(orderId, securityId);
    return res.status(400).json({ success: false, error: 'Expired and reassigned' });
  }

  await db.collection('security_assignments').updateOne({ _id: a._id }, { $set: { status: 'confirmed', confirmedAt: new Date(), confirmedBy: w.name, completionTime: Math.floor(elapsed) } });
  await db.collection('orders').updateOne({ orderId }, { $set: { status: 'verified', verifiedAt: new Date(), verifiedBy: `Security-${securityId} (${w.name})`, updatedAt: new Date() } });
  await updateSecurityStats(securityId, 'confirmed');

  res.json({ success: true, message: 'Confirmed', completionTime: Math.floor(elapsed) });
});

app.get('/api/security/stats/:securityId', checkDB, async (req, res) => {
  const { securityId } = req.params;
  const w = await db.collection('security_watchmen').findOne({ securityId, status: 'active' });
  if (!w) return res.status(404).json({ success: false, error: 'Watchman not found' });

  let stats = await db.collection('security_stats').findOne({ securityId }) || {
    securityId, totalAssigned: 0, totalConfirmed: 0, totalExpired: 0, totalPending: 0, averageCompletionTime: 0, efficiency: 0, lastUpdated: new Date()
  };
  const pending = await db.collection('security_assignments').countDocuments({ securityId, status: 'assigned', assignedAt: { $gte: new Date(Date.now() - 5 * 60000) } });
  stats.totalPending = pending;
  stats.efficiency = stats.totalAssigned ? Math.round((stats.totalConfirmed / stats.totalAssigned) * 100) : 0;
  res.json({ success: true, stats });
});

// The rest of the routes (assign, reassignOrder, updateSecurityStats, etc.) and the server startup code would follow similar compression

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  try { await connectDB(); } catch (e) { console.error('Initial DB connect failed:', e); }
});
