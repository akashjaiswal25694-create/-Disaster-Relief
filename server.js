const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-here';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/disaster_preparedness', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

// User Schema
const userSchema = new mongoose.Schema({
    fullName: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    phone: String,
    region: String,
    createdAt: { type: Date, default: Date.now },
    progress: {
        trainingCompleted: { type: Number, default: 0 },
        plansCreated: { type: Number, default: 0 },
        preparednessScore: { type: Number, default: 0 }
    }
});

// Training Progress Schema
const progressSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    courseId: String,
    courseName: String,
    progress: { type: Number, default: 0 },
    completed: { type: Boolean, default: false },
    lastUpdated: { type: Date, default: Date.now }
});

// Emergency Plan Schema
const planSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    planName: String,
    planType: String,
    steps: [String],
    supplies: [String],
    contacts: [{
        name: String,
        phone: String,
        relationship: String
    }],
    completed: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

// Alert Schema
const alertSchema = new mongoose.Schema({
    title: String,
    description: String,
    type: String,
    severity: String,
    region: String,
    expiresAt: Date,
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Progress = mongoose.model('Progress', progressSchema);
const Plan = mongoose.model('Plan', planSchema);
const Alert = mongoose.model('Alert', alertSchema);

// Authentication Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
};

// Routes

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// User Registration
app.post('/api/register', async (req, res) => {
    try {
        const { fullName, email, password, phone, region } = req.body;

        // Check if user exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ error: 'User already exists' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 12);

        // Create user
        const user = new User({
            fullName,
            email,
            password: hashedPassword,
            phone,
            region
        });

        await user.save();

        // Create token
        const token = jwt.sign(
            { userId: user._id, email: user.email },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.status(201).json({
            message: 'User created successfully',
            token,
            user: {
                id: user._id,
                fullName: user.fullName,
                email: user.email,
                region: user.region
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error during registration' });
    }
});

// User Login
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Find user
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        // Check password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        // Create token
        const token = jwt.sign(
            { userId: user._id, email: user.email },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            message: 'Login successful',
            token,
            user: {
                id: user._id,
                fullName: user.fullName,
                email: user.email,
                region: user.region,
                progress: user.progress
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error during login' });
    }
});

// Get User Dashboard Data
app.get('/api/dashboard', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;

        const user = await User.findById(userId);
        const progress = await Progress.find({ userId });
        const plans = await Plan.find({ userId });
        const alerts = await Alert.find({ 
            region: user.region,
            expiresAt: { $gt: new Date() }
        }).sort({ createdAt: -1 });

        // Calculate overall progress
        const totalProgress = progress.reduce((acc, curr) => acc + curr.progress, 0) / (progress.length || 1);
        const completedPlans = plans.filter(plan => plan.completed).length;

        res.json({
            user: {
                fullName: user.fullName,
                email: user.email,
                region: user.region
            },
            stats: {
                trainingProgress: Math.round(totalProgress),
                plansReady: completedPlans,
                totalPlans: plans.length,
                preparednessScore: user.progress.preparednessScore || Math.round(totalProgress * 0.7 + completedPlans * 6)
            },
            progress,
            plans,
            alerts
        });
    } catch (error) {
        res.status(500).json({ error: 'Error fetching dashboard data' });
    }
});

// Update Training Progress
app.post('/api/progress', authenticateToken, async (req, res) => {
    try {
        const { courseId, courseName, progress, completed } = req.body;
        const userId = req.user.userId;

        let progressDoc = await Progress.findOne({ userId, courseId });

        if (progressDoc) {
            progressDoc.progress = progress;
            progressDoc.completed = completed;
            progressDoc.lastUpdated = new Date();
        } else {
            progressDoc = new Progress({
                userId,
                courseId,
                courseName,
                progress,
                completed
            });
        }

        await progressDoc.save();

        // Update user's overall progress
        const allProgress = await Progress.find({ userId });
        const totalProgress = allProgress.reduce((acc, curr) => acc + curr.progress, 0) / (allProgress.length || 1);
        
        await User.findByIdAndUpdate(userId, {
            'progress.trainingCompleted': Math.round(totalProgress)
        });

        res.json({ message: 'Progress updated successfully', progress: progressDoc });
    } catch (error) {
        res.status(500).json({ error: 'Error updating progress' });
    }
});

// Emergency Plans CRUD
app.get('/api/plans', authenticateToken, async (req, res) => {
    try {
        const plans = await Plan.find({ userId: req.user.userId }).sort({ createdAt: -1 });
        res.json(plans);
    } catch (error) {
        res.status(500).json({ error: 'Error fetching plans' });
    }
});

app.post('/api/plans', authenticateToken, async (req, res) => {
    try {
        const { planName, planType, steps, supplies, contacts } = req.body;
        
        const plan = new Plan({
            userId: req.user.userId,
            planName,
            planType,
            steps,
            supplies,
            contacts
        });

        await plan.save();

        // Update user's plan count
        await User.findByIdAndUpdate(req.user.userId, {
            $inc: { 'progress.plansCreated': 1 }
        });

        res.status(201).json({ message: 'Plan created successfully', plan });
    } catch (error) {
        res.status(500).json({ error: 'Error creating plan' });
    }
});

app.put('/api/plans/:id', authenticateToken, async (req, res) => {
    try {
        const { completed, ...updateData } = req.body;
        const plan = await Plan.findOneAndUpdate(
            { _id: req.params.id, userId: req.user.userId },
            updateData,
            { new: true }
        );

        if (!plan) {
            return res.status(404).json({ error: 'Plan not found' });
        }

        res.json({ message: 'Plan updated successfully', plan });
    } catch (error) {
        res.status(500).json({ error: 'Error updating plan' });
    }
});

// Weather Alerts
app.get('/api/alerts', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        const alerts = await Alert.find({ 
            region: user.region,
            expiresAt: { $gt: new Date() }
        }).sort({ createdAt: -1 });
        
        res.json(alerts);
    } catch (error) {
        res.status(500).json({ error: 'Error fetching alerts' });
    }
});

// Mock Data Endpoints (for demo)
app.post('/api/mock-data', async (req, res) => {
    try {
        // Create sample alerts
        const sampleAlerts = [
            {
                title: 'Severe Thunderstorm Warning',
                description: 'Heavy thunderstorms expected in your area',
                type: 'weather',
                severity: 'high',
                region: 'north',
                expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000)
            },
            {
                title: 'High Wind Advisory',
                description: 'Strong winds expected tomorrow',
                type: 'weather',
                severity: 'medium',
                region: 'north',
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            }
        ];

        await Alert.insertMany(sampleAlerts);
        res.json({ message: 'Mock data created successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error creating mock data' });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Disaster Preparedness Backend API Active`);
    console.log(`🔗 http://localhost:${PORT}`);
});

module.exports = app;