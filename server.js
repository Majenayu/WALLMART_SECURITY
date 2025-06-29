const express = require('express');
const { MongoClient } = require('mongodb');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://wal:wal@wal.ixnqgpx.mongodb.net/qr_items?retryWrites=true&w=majority&appName=Wal';

let db, mongoClient;

app.use(cors({ origin: true, credentials: true }));
app.use(express.static('.'));
app.use(express.json({ limit: '10mb' }));

const connectDB = async () => {
  if (mongoClient) try { await mongoClient.close(); } catch {}
  mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await mongoClient.connect();
  db = mongoClient.db('qr_items');
  console.log('MongoDB connected');
};

const checkDB = async (req, res, next) => {
  if (!db) try { await connectDB(); } catch { return res.status(500).json({ success: false, error: 'DB connection failed' }); }
  try { await db.admin().ping(); next(); } catch { try { await connectDB(); next(); } catch { res.status(500).json({ success: false, error: 'DB unavailable' }); }}
};

// Serve static files
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Get Order for Bill - NEW ENDPOINT
app.get('/api/order/:orderId', checkDB, async (req, res) => {
  try {
    const { orderId } = req.params;
    
    // Fetch order data
    const order = await db.collection('orders').findOne({ orderId });
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    // Fetch security assignment data
    const securityAssignment = await db.collection('security_assignments').findOne({ orderId });
    
    // Prepare complete order data for bill
    const orderData = {
      orderId: order.orderId,
      customer: order.customer || 'Customer',
      items: order.items || [],
      total: order.total || 0,
      status: order.status,
      createdAt: order.createdAt,
      completedAt: order.completedAt,
      // Include security information if available
      securityInfo: securityAssignment ? {
        securityId: securityAssignment.securityId,
        watchmanName: securityAssignment.watchmanName,
        status: securityAssignment.status,
        assignedAt: securityAssignment.assignedAt,
        confirmedAt: securityAssignment.confirmedAt,
        completionTime: securityAssignment.completionTime
      } : null
    };

    res.json({ success: true, order: orderData });
  } catch (error) {
    console.error('Error fetching order for bill:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch order data' });
  }
});

// Security Registration
app.post('/api/security/register', checkDB, async (req, res) => {
  try {
    const { name, contact, email } = req.body;
    if (!name || !contact || name.length < 2 || contact.length < 10) {
      return res.status(400).json({ success: false, error: 'Invalid name or contact' });
    }

    const nameLower = name.trim().toLowerCase();
    const existing = await db.collection('security_watchmen').findOne({ nameLower });
    if (existing) return res.status(400).json({ success: false, error: 'Name already registered' });

    const usedIds = await db.collection('security_watchmen').find({}, { projection: { securityId: 1 } }).toArray();
    const usedSecurityIds = usedIds.map(w => parseInt(w.securityId));
    const availableId = ['1', '2', '3', '4', '5'].find(id => !usedSecurityIds.includes(parseInt(id)));
    if (!availableId) return res.status(400).json({ success: false, error: 'Max 5 watchmen limit reached' });

    const newWatchman = {
      name: name.trim(), nameLower, contact: contact.trim(), email: email?.trim() || '',
      securityId: availableId, registeredAt: new Date(), status: 'active'
    };

    await db.collection('security_watchmen').insertOne(newWatchman);
    await db.collection('security_stats').insertOne({
      securityId: availableId, totalAssigned: 0, totalConfirmed: 0, totalPending: 0, efficiency: 0, createdAt: new Date()
    });

    res.json({ success: true, securityId: availableId, watchman: { name: newWatchman.name, securityId: availableId, contact: newWatchman.contact, email: newWatchman.email }});
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

// Security Login
app.post('/api/security/login', checkDB, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || name.length < 2) return res.status(400).json({ success: false, error: 'Name required' });

    const watchman = await db.collection('security_watchmen').findOne({ nameLower: name.trim().toLowerCase(), status: 'active' });
    if (!watchman) return res.status(404).json({ success: false, error: 'Watchman not found' });

    await db.collection('security_watchmen').updateOne({ _id: watchman._id }, { $set: { lastLogin: new Date() }});

    res.json({ success: true, watchman: { name: watchman.name, securityId: watchman.securityId, contact: watchman.contact, email: watchman.email }});
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// Get Orders for Security
app.get('/api/security/orders/:securityId', checkDB, async (req, res) => {
  try {
    const { securityId } = req.params;
    if (!['1', '2', '3', '4', '5'].includes(securityId)) return res.status(400).json({ success: false, error: 'Invalid security ID' });

    const watchman = await db.collection('security_watchmen').findOne({ securityId, status: 'active' });
    if (!watchman) return res.status(404).json({ success: false, error: 'Watchman not found' });

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const assignments = await db.collection('security_assignments')
      .find({ securityId, status: 'assigned', assignedAt: { $gte: fiveMinutesAgo }})
      .sort({ assignedAt: -1 }).limit(10).toArray();

    const orders = [];
    for (const assignment of assignments) {
      const order = await db.collection('orders').findOne({ orderId: assignment.orderId });
      if (order && order.status === 'completed') {
        orders.push({
          orderId: order.orderId,
          customerName: order.customer || 'Unknown Customer',
          items: order.items || [],
          totalAmount: order.total || 0,
          assignedAt: assignment.assignedAt
        });
      }
    }

    res.json({ success: true, orders });
  } catch (error) {
    console.error('Error loading orders:', error);
    res.status(500).json({ success: false, error: 'Failed to load orders' });
  }
});

// Confirm Order
app.post('/api/security/confirm/:orderId', checkDB, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { securityId, watchmanName } = req.body;
    if (!orderId || !securityId || !watchmanName) return res.status(400).json({ success: false, error: 'Missing fields' });

    const watchman = await db.collection('security_watchmen').findOne({ securityId, status: 'active' });
    if (!watchman || watchman.nameLower !== watchmanName.trim().toLowerCase()) {
      return res.status(403).json({ success: false, error: 'Watchman verification failed' });
    }

    const assignment = await db.collection('security_assignments').findOne({ orderId, securityId, status: 'assigned' });
    if (!assignment) return res.status(404).json({ success: false, error: 'Assignment not found' });

    const elapsedSeconds = Math.floor((Date.now() - new Date(assignment.assignedAt).getTime()) / 1000);
    if (elapsedSeconds > 300) {
      await db.collection('security_assignments').updateOne({ _id: assignment._id }, { $set: { status: 'expired' }});
      return res.status(400).json({ success: false, error: 'Assignment expired' });
    }

    // Confirm assignment
    await db.collection('security_assignments').updateOne(
      { _id: assignment._id },
      { $set: { status: 'confirmed', confirmedAt: new Date(), confirmedBy: watchman.name, completionTime: elapsedSeconds }}
    );

    // Update order
    await db.collection('orders').updateOne(
      { orderId },
      { $set: { status: 'verified', verifiedAt: new Date(), verifiedBy: `Security-${securityId} (${watchman.name})` }}
    );

    // Add to work log
    await db.collection('security_worklog').insertOne({
      securityId, watchmanName: watchman.name, orderId,
      customerName: assignment.customerName || 'Unknown',
      amount: assignment.totalAmount || 0,
      completionTime: elapsedSeconds,
      timestamp: new Date(),
      date: new Date().toISOString().split('T')[0]
    });

    // Update stats
    await db.collection('security_stats').updateOne(
      { securityId },
      { $inc: { totalConfirmed: 1 }, $set: { lastUpdated: new Date() }},
      { upsert: true }
    );

    res.json({ success: true, completionTime: elapsedSeconds });
  } catch (error) {
    console.error('Error confirming order:', error);
    res.status(500).json({ success: false, error: 'Failed to confirm order' });
  }
});

// Get Security Stats
app.get('/api/security/stats/:securityId', checkDB, async (req, res) => {
  try {
    const { securityId } = req.params;
    const watchman = await db.collection('security_watchmen').findOne({ securityId, status: 'active' });
    if (!watchman) return res.status(404).json({ success: false, error: 'Watchman not found' });

    let stats = await db.collection('security_stats').findOne({ securityId });
    if (!stats) {
      stats = { securityId, totalAssigned: 0, totalConfirmed: 0, totalPending: 0, efficiency: 0 };
      await db.collection('security_stats').insertOne(stats);
    }

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const pendingCount = await db.collection('security_assignments').countDocuments({ 
      securityId, status: 'assigned', assignedAt: { $gte: fiveMinutesAgo }
    });

    stats.totalPending = pendingCount;
    stats.efficiency = stats.totalAssigned > 0 ? Math.round((stats.totalConfirmed / stats.totalAssigned) * 100) : 0;

    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

// Get Work Log
app.get('/api/security/worklog/:securityId', checkDB, async (req, res) => {
  try {
    const { securityId } = req.params;
    const today = new Date().toISOString().split('T')[0];
    
    const workLog = await db.collection('security_worklog')
      .find({ securityId, date: today })
      .sort({ timestamp: -1 })
      .limit(20)
      .toArray();

    res.json({ success: true, workLog });
  } catch (error) {
    console.error('Error fetching work log:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch work log' });
  }
});

// Assign Order to Security (called when order is completed)
app.post('/api/security/assign', checkDB, async (req, res) => {
  try {
    const { orderId, customerName, items, totalAmount } = req.body;
    if (!orderId) return res.status(400).json({ success: false, error: 'Order ID required' });

    const watchmen = await db.collection('security_watchmen').find({ status: 'active' }).sort({ securityId: 1 }).toArray();
    if (watchmen.length === 0) return res.status(404).json({ success: false, error: 'No active watchmen' });

    // Simple round-robin assignment
    const assignments = await db.collection('security_assignments').find({}).sort({ assignedAt: -1 }).limit(1).toArray();
    let nextIndex = 0;
    if (assignments.length > 0) {
      const lastIndex = watchmen.findIndex(w => w.securityId === assignments[0].securityId);
      nextIndex = (lastIndex + 1) % watchmen.length;
    }

    const assignedWatchman = watchmen[nextIndex];
    const assignment = {
      orderId, securityId: assignedWatchman.securityId, watchmanName: assignedWatchman.name,
      customerName: customerName || 'Unknown', items: items || [], totalAmount: totalAmount || 0,
      status: 'assigned', assignedAt: new Date()
    };

    await db.collection('security_assignments').insertOne(assignment);
    await db.collection('security_stats').updateOne(
      { securityId: assignedWatchman.securityId },
      { $inc: { totalAssigned: 1 }, $set: { lastUpdated: new Date() }},
      { upsert: true }
    );

    res.json({ success: true, assignedTo: { securityId: assignedWatchman.securityId, name: assignedWatchman.name }});
  } catch (error) {
    console.error('Error assigning order:', error);
    res.status(500).json({ success: false, error: 'Failed to assign order' });
  }
});

// Get All Watchmen Performance Report
app.get('/api/security/report', checkDB, async (req, res) => {
  try {
    const watchmen = await db.collection('security_watchmen').find({ status: 'active' }).sort({ securityId: 1 }).toArray();
    const report = [];

    for (const watchman of watchmen) {
      const stats = await db.collection('security_stats').findOne({ securityId: watchman.securityId }) || 
        { totalAssigned: 0, totalConfirmed: 0, totalPending: 0, efficiency: 0 };
      
      const today = new Date().toISOString().split('T')[0];
      const todayWork = await db.collection('security_worklog').countDocuments({ 
        securityId: watchman.securityId, date: today 
      });

      const todayEarnings = await db.collection('security_worklog').aggregate([
        { $match: { securityId: watchman.securityId, date: today }},
        { $group: { _id: null, total: { $sum: '$amount' }}}
      ]).toArray();

      report.push({
        securityId: watchman.securityId,
        name: watchman.name,
        contact: watchman.contact,
        registeredAt: watchman.registeredAt,
        lastLogin: watchman.lastLogin,
        stats: {
          ...stats,
          todayWork,
          todayEarnings: todayEarnings[0]?.total || 0
        }
      });
    }

    res.json({ success: true, report });
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ success: false, error: 'Failed to generate report' });
  }
});

// Get All Orders with Security Status - NEW ENDPOINT for complete order list
app.get('/api/orders/all', checkDB, async (req, res) => {
  try {
    const orders = await db.collection('orders').find({}).sort({ createdAt: -1 }).limit(50).toArray();
    
    const ordersWithSecurity = [];
    for (const order of orders) {
      const securityAssignment = await db.collection('security_assignments').findOne({ orderId: order.orderId });
      
      ordersWithSecurity.push({
        ...order,
        securityInfo: securityAssignment ? {
          securityId: securityAssignment.securityId,
          watchmanName: securityAssignment.watchmanName,
          status: securityAssignment.status,
          assignedAt: securityAssignment.assignedAt,
          confirmedAt: securityAssignment.confirmedAt,
          completionTime: securityAssignment.completionTime
        } : null
      });
    }

    res.json({ success: true, orders: ordersWithSecurity });
  } catch (error) {
    console.error('Error fetching all orders:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch orders' });
  }
});

// Cleanup expired assignments
setInterval(async () => {
  try {
    if (!db) return;
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const expired = await db.collection('security_assignments')
      .find({ status: 'assigned', assignedAt: { $lt: fiveMinutesAgo }}).toArray();
    
    for (const assignment of expired) {
      await db.collection('security_assignments').updateOne(
        { _id: assignment._id },
        { $set: { status: 'expired', expiredAt: new Date() }}
      );
    }
    if (expired.length > 0) console.log(`Expired ${expired.length} assignments`);
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}, 60000);

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  try { await connectDB(); } catch (error) { console.error('DB connection failed:', error); }
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  if (mongoClient) await mongoClient.close();
  process.exit(0);
});
