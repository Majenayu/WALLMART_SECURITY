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
  mongoClient = new MongoClient(MONGODB_URI, { 
    serverSelectionTimeoutMS: 15000, 
    socketTimeoutMS: 30000, 
    maxPoolSize: 10 
  });
  await mongoClient.connect();
  db = mongoClient.db('qr_items');
  await db.admin().ping();
  console.log('MongoDB connected');

  // Create indexes for better performance
  const indexes = [
    ['security_watchmen', { name: 1 }, { unique: true }],
    ['security_watchmen', { securityId: 1 }, { unique: true }],
    ['security_watchmen', { contact: 1 }],
    ['security_assignments', { orderId: 1 }],
    ['security_assignments', { securityId: 1 }],
    ['security_assignments', { status: 1 }],
    ['security_assignments', { assignedAt: 1 }],
    ['security_stats', { securityId: 1 }, { unique: true }],
    ['orders', { orderId: 1 }, { unique: true }],
    ['orders', { status: 1 }]
  ];
  
  for (const [collection, keys, options] of indexes) {
    try {
      await db.collection(collection).createIndex(keys, options || {});
    } catch (error) {
      if (error.code !== 11000) console.error(`Index creation failed for ${collection}:`, error);
    }
  }
};

const checkDB = async (req, res, next) => {
  if (!db) {
    try { 
      await connectDB(); 
    } catch { 
      return res.status(500).json({ success: false, error: 'Database connection failed' }); 
    }
  }
  
  try { 
    await db.admin().ping(); 
    next(); 
  } catch { 
    try { 
      await connectDB(); 
      next(); 
    } catch { 
      res.status(500).json({ success: false, error: 'Database unavailable' }); 
    } 
  }
};

// Serve static files
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/bill.html', (req, res) => res.sendFile(path.join(__dirname, 'bill.html')));

// Security Watchman Registration
app.post('/api/security/register', checkDB, async (req, res) => {
  try {
    const { name, contact, email } = req.body;
    
    if (!name || !contact || name.length < 2 || contact.length < 10) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid name or contact number' 
      });
    }

    const nameLower = name.trim().toLowerCase();
    const existing = await db.collection('security_watchmen').findOne({ nameLower });
    
    if (existing) {
      return res.status(400).json({ 
        success: false, 
        error: 'Name already registered. Try logging in.' 
      });
    }

    // Find available security ID (1-5)
    const usedIds = await db.collection('security_watchmen')
      .find({}, { projection: { securityId: 1 } })
      .toArray();
    const usedSecurityIds = usedIds.map(w => parseInt(w.securityId));
    const availableId = ['1', '2', '3', '4', '5'].find(id => !usedSecurityIds.includes(parseInt(id)));
    
    if (!availableId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Maximum 5 watchmen limit reached' 
      });
    }

    const newWatchman = {
      name: name.trim(),
      nameLower,
      contact: contact.trim(),
      email: email?.trim() || '',
      securityId: availableId,
      registeredAt: new Date(),
      status: 'active',
      createdAt: new Date(),
      lastLogin: null
    };

    await db.collection('security_watchmen').insertOne(newWatchman);
    
    // Initialize stats
    await db.collection('security_stats').insertOne({
      securityId: availableId,
      totalAssigned: 0,
      totalConfirmed: 0,
      totalExpired: 0,
      totalPending: 0,
      averageCompletionTime: 0,
      efficiency: 0,
      createdAt: new Date(),
      lastUpdated: new Date()
    });

    res.json({ 
      success: true, 
      message: 'Registration successful', 
      securityId: availableId,
      watchman: {
        name: newWatchman.name,
        securityId: availableId,
        contact: newWatchman.contact,
        email: newWatchman.email
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

// Security Watchman Login
app.post('/api/security/login', checkDB, async (req, res) => {
  try {
    const { name } = req.body;
    
    if (!name || name.length < 2) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }

    const watchman = await db.collection('security_watchmen').findOne({ 
      nameLower: name.trim().toLowerCase(),
      status: 'active' 
    });
    
    if (!watchman) {
      return res.status(404).json({ 
        success: false, 
        error: 'Watchman not found or inactive' 
      });
    }

    // Update last login
    await db.collection('security_watchmen').updateOne(
      { _id: watchman._id },
      { 
        $set: { 
          lastLogin: new Date(),
          updatedAt: new Date() 
        } 
      }
    );

    res.json({ 
      success: true, 
      message: 'Login successful',
      watchman: {
        name: watchman.name,
        securityId: watchman.securityId,
        contact: watchman.contact,
        email: watchman.email,
        registeredAt: watchman.registeredAt
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// Get all active watchmen
app.get('/api/security/watchmen', checkDB, async (req, res) => {
  try {
    const watchmen = await db.collection('security_watchmen')
      .find({ status: 'active' }, {
        projection: { 
          name: 1, 
          securityId: 1, 
          contact: 1, 
          email: 1, 
          registeredAt: 1, 
          lastLogin: 1 
        }
      })
      .sort({ securityId: 1 })
      .toArray();
    
    res.json({ success: true, watchmen });
  } catch (error) {
    console.error('Error fetching watchmen:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch watchmen' });
  }
});

// Get orders assigned to a specific security watchman
app.get('/api/security/orders/:securityId', checkDB, async (req, res) => {
  try {
    const { securityId } = req.params;
    const validIds = ['1', '2', '3', '4', '5'];
    
    if (!validIds.includes(securityId)) {
      return res.status(400).json({ success: false, error: 'Invalid security ID' });
    }

    // Verify watchman exists
    const watchman = await db.collection('security_watchmen').findOne({ 
      securityId, 
      status: 'active' 
    });
    
    if (!watchman) {
      return res.status(404).json({ success: false, error: 'Watchman not found' });
    }

    // Get assignments within the last 5 minutes that are still assigned
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const assignments = await db.collection('security_assignments')
      .find({ 
        securityId, 
        status: 'assigned',
        assignedAt: { $gte: fiveMinutesAgo }
      })
      .sort({ assignedAt: -1 })
      .limit(10)
      .toArray();

    // Get order details for each assignment
    const orders = [];
    for (const assignment of assignments) {
      const order = await db.collection('orders').findOne({ 
        orderId: assignment.orderId 
      });
      
      if (order && order.status === 'completed') {
        orders.push({
          orderId: order.orderId,
          customerName: order.customer || 'Unknown Customer',
          items: order.items || [],
          totalAmount: order.total || 0,
          assignedAt: assignment.assignedAt,
          assignmentId: assignment._id,
          status: assignment.status
        });
      }
    }

    res.json({ success: true, orders });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch orders' });
  }
});

// Confirm order delivery by security watchman
app.post('/api/security/confirm/:orderId', checkDB, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { securityId, watchmanName } = req.body;
    
    if (!orderId || !securityId || !watchmanName) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields' 
      });
    }

    // Verify watchman
    const watchman = await db.collection('security_watchmen').findOne({ 
      securityId, 
      status: 'active' 
    });
    
    if (!watchman || watchman.nameLower !== watchmanName.trim().toLowerCase()) {
      return res.status(403).json({ 
        success: false, 
        error: 'Watchman verification failed' 
      });
    }

    // Find assignment
    const assignment = await db.collection('security_assignments').findOne({ 
      orderId, 
      securityId, 
      status: 'assigned' 
    });
    
    if (!assignment) {
      return res.status(404).json({ 
        success: false, 
        error: 'Assignment not found or already processed' 
      });
    }

    // Check if assignment has expired (5 minutes)
    const assignedTime = new Date(assignment.assignedAt);
    const elapsedSeconds = (Date.now() - assignedTime.getTime()) / 1000;
    
    if (elapsedSeconds > 300) { // 5 minutes = 300 seconds
      // Mark as expired and reassign
      await db.collection('security_assignments').updateOne(
        { _id: assignment._id },
        { 
          $set: { 
            status: 'expired',
            expiredAt: new Date()
          } 
        }
      );
      
      await reassignOrder(orderId, securityId);
      await updateSecurityStats(securityId, 'expired');
      
      return res.status(400).json({ 
        success: false, 
        error: 'Assignment expired and has been reassigned' 
      });
    }

    // Confirm the assignment
    await db.collection('security_assignments').updateOne(
      { _id: assignment._id },
      { 
        $set: { 
          status: 'confirmed',
          confirmedAt: new Date(),
          confirmedBy: watchman.name,
          completionTime: Math.floor(elapsedSeconds)
        } 
      }
    );

    // Update order status
    await db.collection('orders').updateOne(
      { orderId },
      { 
        $set: { 
          status: 'verified',
          verifiedAt: new Date(),
          verifiedBy: `Security-${securityId} (${watchman.name})`,
          updatedAt: new Date()
        } 
      }
    );

    // Update stats
    await updateSecurityStats(securityId, 'confirmed');

    res.json({ 
      success: true, 
      message: 'Order confirmed successfully',
      completionTime: Math.floor(elapsedSeconds)
    });
  } catch (error) {
    console.error('Error confirming order:', error);
    res.status(500).json({ success: false, error: 'Failed to confirm order' });
  }
});

// Get security stats
app.get('/api/security/stats/:securityId', checkDB, async (req, res) => {
  try {
    const { securityId } = req.params;
    
    // Verify watchman exists
    const watchman = await db.collection('security_watchmen').findOne({ 
      securityId, 
      status: 'active' 
    });
    
    if (!watchman) {
      return res.status(404).json({ success: false, error: 'Watchman not found' });
    }

    // Get stats from database
    let stats = await db.collection('security_stats').findOne({ securityId });
    
    if (!stats) {
      // Create initial stats if not found
      stats = {
        securityId,
        totalAssigned: 0,
        totalConfirmed: 0,
        totalExpired: 0,
        totalPending: 0,
        averageCompletionTime: 0,
        efficiency: 0,
        lastUpdated: new Date()
      };
      await db.collection('security_stats').insertOne(stats);
    }

    // Get current pending count
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const pendingCount = await db.collection('security_assignments').countDocuments({ 
      securityId, 
      status: 'assigned',
      assignedAt: { $gte: fiveMinutesAgo }
    });

    stats.totalPending = pendingCount;
    stats.efficiency = stats.totalAssigned > 0 
      ? Math.round((stats.totalConfirmed / stats.totalAssigned) * 100) 
      : 0;

    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

// Get specific order details (for bill generation)
app.get('/api/order/:orderId', checkDB, async (req, res) => {
  try {
    const { orderId } = req.params;
    
    const order = await db.collection('orders').findOne({ orderId });
    
    if (!order) {
      return res.status(404).json({ 
        success: false, 
        error: 'Order not found' 
      });
    }

    // Get security assignment info if available
    const assignment = await db.collection('security_assignments').findOne({ 
      orderId,
      status: { $in: ['assigned', 'confirmed'] }
    });

    let securityInfo = null;
    if (assignment) {
      const watchman = await db.collection('security_watchmen').findOne({ 
        securityId: assignment.securityId 
      });
      
      securityInfo = {
        securityId: assignment.securityId,
        watchmanName: watchman ? watchman.name : 'Unknown',
        status: assignment.status,
        assignedAt: assignment.assignedAt,
        confirmedAt: assignment.confirmedAt || null
      };
    }

    const orderData = {
      orderId: order.orderId,
      customer: order.customer || 'Unknown Customer',
      items: order.items || [],
      total: order.total || 0,
      status: order.status,
      createdAt: order.createdAt,
      securityInfo
    };

    res.json({ success: true, order: orderData });
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch order' });
  }
});

// Assign order to security (called when order is completed)
app.post('/api/security/assign', checkDB, async (req, res) => {
  try {
    const { orderId, customerName, items, totalAmount } = req.body;
    
    if (!orderId) {
      return res.status(400).json({ success: false, error: 'Order ID required' });
    }

    // Get available watchmen
    const watchmen = await db.collection('security_watchmen')
      .find({ status: 'active' })
      .sort({ securityId: 1 })
      .toArray();
    
    if (watchmen.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'No active security watchmen available' 
      });
    }

    // Simple round-robin assignment (you can implement more sophisticated logic)
    const assignments = await db.collection('security_assignments')
      .find({})
      .sort({ assignedAt: -1 })
      .limit(1)
      .toArray();
    
    let nextWatchmanIndex = 0;
    if (assignments.length > 0) {
      const lastAssignedSecurityId = assignments[0].securityId;
      const lastIndex = watchmen.findIndex(w => w.securityId === lastAssignedSecurityId);
      nextWatchmanIndex = (lastIndex + 1) % watchmen.length;
    }

    const assignedWatchman = watchmen[nextWatchmanIndex];

    // Create assignment
    const assignment = {
      orderId,
      securityId: assignedWatchman.securityId,
      watchmanName: assignedWatchman.name,
      customerName: customerName || 'Unknown Customer',
      items: items || [],
      totalAmount: totalAmount || 0,
      status: 'assigned',
      assignedAt: new Date(),
      createdAt: new Date()
    };

    await db.collection('security_assignments').insertOne(assignment);
    await updateSecurityStats(assignedWatchman.securityId, 'assigned');

    res.json({ 
      success: true, 
      message: 'Order assigned to security',
      assignedTo: {
        securityId: assignedWatchman.securityId,
        name: assignedWatchman.name
      }
    });
  } catch (error) {
    console.error('Error assigning order:', error);
    res.status(500).json({ success: false, error: 'Failed to assign order' });
  }
});

// Helper function to reassign expired orders
async function reassignOrder(orderId, currentSecurityId) {
  try {
    const watchmen = await db.collection('security_watchmen')
      .find({ 
        status: 'active',
        securityId: { $ne: currentSecurityId }
      })
      .toArray();
    
    if (watchmen.length === 0) {
      console.log('No other watchmen available for reassignment');
      return;
    }

    // Assign to next available watchman
    const nextWatchman = watchmen[0];
    
    const newAssignment = {
      orderId,
      securityId: nextWatchman.securityId,
      watchmanName: nextWatchman.name,
      status: 'assigned',
      assignedAt: new Date(),
      reassignedFrom: currentSecurityId,
      createdAt: new Date()
    };

    await db.collection('security_assignments').insertOne(newAssignment);
    await updateSecurityStats(nextWatchman.securityId, 'assigned');
    
    console.log(`Order ${orderId} reassigned from ${currentSecurityId} to ${nextWatchman.securityId}`);
  } catch (error) {
    console.error('Error reassigning order:', error);
  }
}

// Helper function to update security stats
async function updateSecurityStats(securityId, action) {
  try {
    const updateData = { lastUpdated: new Date() };
    
    switch (action) {
      case 'assigned':
        updateData.$inc = { totalAssigned: 1 };
        break;
      case 'confirmed':
        updateData.$inc = { totalConfirmed: 1 };
        break;
      case 'expired':
        updateData.$inc = { totalExpired: 1 };
        break;
    }

    await db.collection('security_stats').updateOne(
      { securityId },
      updateData,
      { upsert: true }
    );
  } catch (error) {
    console.error('Error updating security stats:', error);
  }
}

// Cleanup expired assignments (run periodically)
async function cleanupExpiredAssignments() {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    const expiredAssignments = await db.collection('security_assignments')
      .find({ 
        status: 'assigned',
        assignedAt: { $lt: fiveMinutesAgo }
      })
      .toArray();

    for (const assignment of expiredAssignments) {
      await db.collection('security_assignments').updateOne(
        { _id: assignment._id },
        { 
          $set: { 
            status: 'expired',
            expiredAt: new Date()
          } 
        }
      );
      
      await updateSecurityStats(assignment.securityId, 'expired');
      await reassignOrder(assignment.orderId, assignment.securityId);
    }

    if (expiredAssignments.length > 0) {
      console.log(`Cleaned up ${expiredAssignments.length} expired assignments`);
    }
  } catch (error) {
    console.error('Error cleaning up expired assignments:', error);
  }
}

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    success: false, 
    error: 'Internal server error' 
  });
});

// Start server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  try { 
    await connectDB();
    
    // Set up periodic cleanup of expired assignments
    setInterval(cleanupExpiredAssignments, 60000); // Every minute
    
  } catch (error) { 
    console.error('Initial database connection failed:', error); 
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  if (mongoClient) {
    await mongoClient.close();
  }
  process.exit(0);
});
