const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? [process.env.FRONTEND_URL, /\.render\.com$/, 'http://localhost:3000']
        : ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000', 'http://127.0.0.1:3001'],
    credentials: true
}));
app.use(express.static('.'));
app.use(express.json({ limit: '10mb' }));

// Database connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://wal:wal@wal.ixnqgpx.mongodb.net/qr_items?retryWrites=true&w=majority&appName=Wal';
let db, mongoClient;

async function connectDB() {
    if (mongoClient) {
        try { await mongoClient.close(); } catch (e) {}
    }
    
    mongoClient = new MongoClient(MONGODB_URI, {
        serverSelectionTimeoutMS: 15000,
        socketTimeoutMS: 30000,
        maxPoolSize: 10
    });
    
    await mongoClient.connect();
    db = mongoClient.db('qr_items');
    await db.admin().ping();
    console.log('Security Server - MongoDB connected');
    
    // Create indexes for security collections
    try {
        await Promise.all([
            db.collection('security_assignments').createIndex({ orderId: 1 }),
            db.collection('security_assignments').createIndex({ securityId: 1 }),
            db.collection('security_assignments').createIndex({ status: 1 }),
            db.collection('security_assignments').createIndex({ assignedAt: 1 }),
            db.collection('security_stats').createIndex({ securityId: 1 }, { unique: true }),
            db.collection('orders').createIndex({ orderId: 1 }),
            db.collection('orders').createIndex({ status: 1 })
        ]);
        console.log('Security indexes created successfully');
    } catch (e) {
        console.log('Index creation info:', e.message);
    }
}

const checkDB = async (req, res, next) => {
    if (!db) {
        try { 
            await connectDB(); 
        } catch (error) { 
            return res.status(500).json({ success: false, error: 'Database connection failed' }); 
        }
    }
    
    try {
        await db.admin().ping();
        next();
    } catch (error) {
        try { 
            await connectDB(); 
            next(); 
        } catch (e) { 
            return res.status(500).json({ success: false, error: 'Database unavailable' }); 
        }
    }
};

// Serve the security index page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Security Assignment Routes

// Get orders assigned to a specific security ID
app.get('/api/security/orders/:securityId', checkDB, async (req, res) => {
    try {
        const securityId = req.params.securityId;
        
        if (!securityId || !['1', '2', '3', '4', '5'].includes(securityId)) {
            return res.status(400).json({ success: false, error: 'Invalid security ID' });
        }
        
        // Get active assignments for this security ID
        const assignments = await db.collection('security_assignments')
            .find({ 
                securityId: securityId,
                status: 'assigned',
                assignedAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) } // Within last 5 minutes
            })
            .sort({ assignedAt: -1 })
            .limit(3) // Maximum 3 orders at a time
            .toArray();
        
        // Get full order details for each assignment
        const orders = [];
        for (const assignment of assignments) {
            const order = await db.collection('orders').findOne({ orderId: assignment.orderId });
            if (order && order.status === 'completed') {
                orders.push({
                    ...order,
                    assignedAt: assignment.assignedAt,
                    assignmentId: assignment._id
                });
            }
        }
        
        res.json({ success: true, orders });
    } catch (error) {
        console.error('Error fetching assigned orders:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch orders' });
    }
});

// Confirm order verification by security
app.post('/api/security/confirm/:orderId', checkDB, async (req, res) => {
    try {
        const orderId = req.params.orderId;
        const { securityId, watchmanName } = req.body;
        
        if (!orderId || !securityId || !watchmanName) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        
        if (!['1', '2', '3', '4', '5'].includes(securityId)) {
            return res.status(400).json({ success: false, error: 'Invalid security ID' });
        }
        
        // Find the assignment
        const assignment = await db.collection('security_assignments').findOne({
            orderId: orderId,
            securityId: securityId,
            status: 'assigned'
        });
        
        if (!assignment) {
            return res.status(404).json({ success: false, error: 'Assignment not found or already processed' });
        }
        
        // Check if assignment is not expired (5 minutes)
        const assignedTime = new Date(assignment.assignedAt);
        const timeElapsed = (Date.now() - assignedTime.getTime()) / 1000;
        
        if (timeElapsed > 300) { // 5 minutes
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
            
            // Reassign to next available security
            await reassignOrder(orderId, securityId);
            
            return res.status(400).json({ success: false, error: 'Assignment expired and reassigned' });
        }
        
        // Update assignment status to confirmed
        await db.collection('security_assignments').updateOne(
            { _id: assignment._id },
            {
                $set: {
                    status: 'confirmed',
                    confirmedAt: new Date(),
                    confirmedBy: watchmanName,
                    completionTime: Math.floor(timeElapsed)
                }
            }
        );
        
        // Update order status to verified
        await db.collection('orders').updateOne(
            { orderId: orderId },
            {
                $set: {
                    status: 'verified',
                    verifiedAt: new Date(),
                    verifiedBy: `Security-${securityId} (${watchmanName})`,
                    updatedAt: new Date()
                }
            }
        );
        
        // Update security stats
        await updateSecurityStats(securityId, 'confirmed');
        
        res.json({ 
            success: true, 
            message: 'Order verified successfully',
            completionTime: Math.floor(timeElapsed)
        });
        
    } catch (error) {
        console.error('Error confirming order:', error);
        res.status(500).json({ success: false, error: 'Failed to confirm order' });
    }
});

// Get security statistics
app.get('/api/security/stats/:securityId', checkDB, async (req, res) => {
    try {
        const securityId = req.params.securityId;
        
        if (!['1', '2', '3', '4', '5'].includes(securityId)) {
            return res.status(400).json({ success: false, error: 'Invalid security ID' });
        }
        
        // Get or create stats record
        let stats = await db.collection('security_stats').findOne({ securityId: securityId });
        
        if (!stats) {
            stats = {
                securityId: securityId,
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
        
        // Calculate real-time pending count
        const pendingCount = await db.collection('security_assignments').countDocuments({
            securityId: securityId,
            status: 'assigned',
            assignedAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) }
        });
        
        stats.totalPending = pendingCount;
        stats.efficiency = stats.totalAssigned > 0 ? 
            Math.round((stats.totalConfirmed / stats.totalAssigned) * 100) : 0;
        
        res.json({ success: true, stats });
        
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch statistics' });
    }
});

// Admin route to assign orders to security (called from main shopping system)
app.post('/api/security/assign', checkDB, async (req, res) => {
    try {
        const { orderId } = req.body;
        
        if (!orderId) {
            return res.status(400).json({ success: false, error: 'Order ID required' });
        }
        
        // Check if order exists and is completed
        const order = await db.collection('orders').findOne({ 
            orderId: orderId,
            status: 'completed'
        });
        
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found or not completed' });
        }
        
        // Check if already assigned
        const existingAssignment = await db.collection('security_assignments').findOne({
            orderId: orderId,
            status: { $in: ['assigned', 'confirmed'] }
        });
        
        if (existingAssignment) {
            return res.status(400).json({ success: false, error: 'Order already assigned' });
        }
        
        // Find least busy security ID
        const securityId = await findAvailableSecurityId();
        
        // Create assignment
        const assignment = {
            orderId: orderId,
            securityId: securityId,
            status: 'assigned',
            assignedAt: new Date(),
            createdAt: new Date()
        };
        
        await db.collection('security_assignments').insertOne(assignment);
        
        // Update security stats
        await updateSecurityStats(securityId, 'assigned');
        
        res.json({ 
            success: true, 
            message: 'Order assigned successfully',
            securityId: securityId,
            assignmentId: assignment._id
        });
        
    } catch (error) {
        console.error('Error assigning order:', error);
        res.status(500).json({ success: false, error: 'Failed to assign order' });
    }
});

// Helper Functions

async function findAvailableSecurityId() {
    try {
        // Get current workload for each security ID
        const workloads = [];
        
        for (let i = 1; i <= 5; i++) {
            const pendingCount = await db.collection('security_assignments').countDocuments({
                securityId: i.toString(),
                status: 'assigned',
                assignedAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) }
            });
            
            workloads.push({ securityId: i.toString(), pendingCount });
        }
        
        // Sort by least busy (lowest pending count)
        workloads.sort((a, b) => a.pendingCount - b.pendingCount);
        
        // Return the least busy security ID, or first one if all equal
        return workloads[0].securityId;
        
    } catch (error) {
        console.error('Error finding available security:', error);
        return '1'; // Default to security ID 1
    }
}

async function reassignOrder(orderId, excludeSecurityId) {
    try {
        // Find next available security ID (excluding the expired one)
        const availableIds = ['1', '2', '3', '4', '5'].filter(id => id !== excludeSecurityId);
        
        if (availableIds.length === 0) {
            console.error('No available security IDs for reassignment');
            return;
        }
        
        // Get workloads for available IDs
        const workloads = [];
        for (const id of availableIds) {
            const pendingCount = await db.collection('security_assignments').countDocuments({
                securityId: id,
                status: 'assigned',
                assignedAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) }
            });
            workloads.push({ securityId: id, pendingCount });
        }
        
        // Sort by least busy
        workloads.sort((a, b) => a.pendingCount - b.pendingCount);
        const newSecurityId = workloads[0].securityId;
        
        // Create new assignment
        const newAssignment = {
            orderId: orderId,
            securityId: newSecurityId,
            status: 'assigned',
            assignedAt: new Date(),
            reassignedFrom: excludeSecurityId,
            createdAt: new Date()
        };
        
        await db.collection('security_assignments').insertOne(newAssignment);
        
        // Update stats
        await updateSecurityStats(newSecurityId, 'assigned');
        await updateSecurityStats(excludeSecurityId, 'expired');
        
        console.log(`Order ${orderId} reassigned from Security-${excludeSecurityId} to Security-${newSecurityId}`);
        
    } catch (error) {
        console.error('Error reassigning order:', error);
    }
}

async function updateSecurityStats(securityId, action) {
    try {
        const update = {};
        
        switch (action) {
            case 'assigned':
                update.$inc = { totalAssigned: 1 };
                break;
            case 'confirmed':
                update.$inc = { totalConfirmed: 1 };
                break;
            case 'expired':
                update.$inc = { totalExpired: 1 };
                break;
        }
        
        update.$set = { lastUpdated: new Date() };
        
        await db.collection('security_stats').updateOne(
            { securityId: securityId },
            update,
            { upsert: true }
        );
        
    } catch (error) {
        console.error('Error updating security stats:', error);
    }
}

// Background job to handle expired assignments
setInterval(async () => {
    if (!db) return;
    
    try {
        // Find assignments that are older than 5 minutes and still assigned
        const expiredAssignments = await db.collection('security_assignments').find({
            status: 'assigned',
            assignedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) }
        }).toArray();
        
        for (const assignment of expiredAssignments) {
            // Mark as expired
            await db.collection('security_assignments').updateOne(
                { _id: assignment._id },
                {
                    $set: {
                        status: 'expired',
                        expiredAt: new Date()
                    }
                }
            );
            
            // Reassign to another security
            await reassignOrder(assignment.orderId, assignment.securityId);
            
            console.log(`Assignment ${assignment._id} expired and reassigned`);
        }
        
    } catch (error) {
        console.error('Error in cleanup job:', error);
    }
}, 30000); // Run every 30 seconds

// Health check
app.get('/api/health', async (req, res) => {
    let dbStatus = 'Disconnected';
    if (db) {
        try {
            await db.admin().ping();
            dbStatus = 'Connected';
        } catch (e) {
            dbStatus = 'Error';
        }
    }
    res.json({ 
        status: 'OK', 
        service: 'Security Watchman Server',
        database: dbStatus, 
        timestamp: new Date().toISOString() 
    });
});

// Integration endpoint for main shopping system
app.post('/api/integration/order-completed', checkDB, async (req, res) => {
    try {
        const { orderId } = req.body;
        
        if (!orderId) {
            return res.status(400).json({ success: false, error: 'Order ID required' });
        }
        
        // Auto-assign completed order to security
        setTimeout(async () => {
            try {
                await fetch(`${req.protocol}://${req.get('host')}/api/security/assign`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ orderId })
                });
            } catch (error) {
                console.error('Auto-assignment error:', error);
            }
        }, 2000); // 2 second delay after order completion
        
        res.json({ success: true, message: 'Order queued for security assignment' });
        
    } catch (error) {
        console.error('Integration error:', error);
        res.status(500).json({ success: false, error: 'Integration failed' });
    }
});

// Error handlers
app.use((error, req, res, next) => {
    console.error('Security Server Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Server startup
const server = app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Security Watchman Server running on port ${PORT}`);
    try {
        await connectDB();
        console.log('Security server fully initialized');
    } catch (error) {
        console.error('Initial DB connection failed:', error);
    }
});

// Graceful shutdown
const shutdown = (signal) => {
    console.log(`${signal} received, shutting down Security server gracefully...`);
    server.close(async () => {
        if (mongoClient) {
            try { 
                await mongoClient.close();
                console.log('Security server database connection closed');
            } catch (e) {
                console.error('Error closing database:', e);
            }
        }
        process.exit(0);
    });
    
    setTimeout(() => {
        console.error('Security server forced shutdown');
        process.exit(1);
    }, 5000);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Database connection monitoring
setInterval(async () => {
    if (db) {
        try { 
            await db.admin().ping(); 
        } catch (error) { 
            console.error('Security server database ping failed, reconnecting...');
            try { 
                await connectDB(); 
            } catch (e) {
                console.error('Security server reconnection failed:', e);
            }
        }
    }
}, 30000);

module.exports = app;