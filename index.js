const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Environment variables
const YOURGPT_API_KEY = process.env.YOURGPT_API_KEY;
const YOURGPT_WIDGET_UID = process.env.YOURGPT_WIDGET_UID;
const YOURGPT_BASE_URL = process.env.YOURGPT_APP_URL;
const TRILLION_WEBHOOK_SECRET = process.env.TRILLION_WEBHOOK_SECRET;

// Validate environment variables
if (!YOURGPT_API_KEY || !YOURGPT_WIDGET_UID) {
    console.error('Missing required environment variables: YOURGPT_API_KEY or YOURGPT_WIDGET_UID');
    process.exit(1);
}

// In-memory storage for active sessions (consider using Redis for production)
const activeSessions = new Map();

/**
 * Create a new YourGPT session
 */
async function createYourGPTSession() {
    try {
        console.log('Creating new YourGPT session...');
        
        const response = await axios.post(`${YOURGPT_BASE_URL}/createSession`, 
            new URLSearchParams({
                'widget_uid': YOURGPT_WIDGET_UID
            }), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'api-key': YOURGPT_API_KEY
                }
            }
        );
        console.log(response, "response of create session");


        if (response.data.type === 'RXSUCCESS') {
            const sessionData = response.data.data;
            console.log('YourGPT session created successfully:', sessionData.session_uid);
            return sessionData.session_uid;
        } else {
            throw new Error('Failed to create YourGPT session: ' + response.data.message);
        }
    } catch (error) {
        console.log(error, "error of create session");
        console.error('Error creating YourGPT session:', error.message);
        throw error;
    }
}

/**
 * Send message to YourGPT
 */
async function sendMessageToYourGPT(sessionUid, message) {
    try {
        console.log(`Sending message to YourGPT session ${sessionUid}:`, message);
        
        const response = await axios.post(`${YOURGPT_BASE_URL}/sendMessage`, 
            new URLSearchParams({
                'widget_uid': YOURGPT_WIDGET_UID,
                'session_uid': sessionUid,
                'message': message
            }), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'api-key': YOURGPT_API_KEY
                }
            }
        );

        if (response.data.type === 'RXSUCCESS') {
            console.log('YourGPT response received successfully');
            return response.data.data;
        } else {
            throw new Error('Failed to send message to YourGPT: ' + response.data.message);
        }
    } catch (error) {
        console.error('Error sending message to YourGPT:', error.message);
        throw error;
    }
}

/**
 * Verify Trillion webhook signature (optional security measure)
 */
function verifyTrillionWebhook(payload, signature) {
    if (!TRILLION_WEBHOOK_SECRET) {
        console.warn('No webhook secret configured, skipping verification');
        return true;
    }
    
    const expectedSignature = crypto
        .createHmac('sha256', TRILLION_WEBHOOK_SECRET)
        .update(payload)
        .digest('hex');
    
    return crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expectedSignature, 'hex')
    );
}

/**
 * Process Trillion webhook and handle YourGPT integration
 */
async function processTrillionWebhook(webhookData) {
    try {
        console.log('Processing Trillion webhook:', JSON.stringify(webhookData, null, 2));
        
        // Extract relevant data from Trillion webhook
        const { 
            user_id, 
            channel_id, 
            message, 
            timestamp, 
            event_type = 'message',
            user_name = 'Unknown User'
        } = webhookData;

        // Skip if not a message event
        if (event_type !== 'message' || !message) {
            console.log('Skipping non-message event or empty message');
            return { success: true, message: 'Event skipped' };
        }

        // Create a unique session identifier based on user and channel
        const sessionKey = `${user_id}_${channel_id}`;
        
        // Always create a fresh session as requested
        console.log(`Creating fresh session for user ${user_id} in channel ${channel_id}`);
        
        // Remove old session if exists
        if (activeSessions.has(sessionKey)) {
            console.log('Removing old session for fresh start');
            activeSessions.delete(sessionKey);
        }
        
        // Create new YourGPT session
        const sessionUid = await createYourGPTSession();
        
        // Store session info
        activeSessions.set(sessionKey, {
            sessionUid,
            userId: user_id,
            channelId: channel_id,
            userName: user_name,
            createdAt: new Date(),
            lastActivity: new Date()
        });

        // Send message to YourGPT
        const gptResponse = await sendMessageToYourGPT(sessionUid, message);
        
        // Update last activity
        const session = activeSessions.get(sessionKey);
        if (session) {
            session.lastActivity = new Date();
        }

        // Prepare response for Trillion
        const responseData = {
            success: true,
            sessionUid: sessionUid,
            userMessage: message,
            gptResponse: gptResponse.message,
            timestamp: new Date().toISOString(),
            choices: gptResponse.choices || []
        };

        console.log('Successfully processed webhook and got GPT response');
        return responseData;

    } catch (error) {
        console.error('Error processing Trillion webhook:', error.message);
        return {
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        };
    }
}

// Routes

/**
 * Home page endpoint
 */
app.get('/', (req, res) => {
    res.json({
        message: 'Welcome to YourGPT Webhook Service',
        version: '1.0.0',
        endpoints: {
            webhook: '/webhook/trillion',
            test: '/test/webhook',
            health: '/health',
            sessions: '/sessions'
        },
        timestamp: new Date().toISOString()
    });
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        activeSessions: activeSessions.size
    });
});

/**
 * Get active sessions info
 */
app.get('/sessions', (req, res) => {
    const sessions = Array.from(activeSessions.entries()).map(([key, session]) => ({
        sessionKey: key,
        sessionUid: session.sessionUid,
        userId: session.userId,
        channelId: session.channelId,
        userName: session.userName,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity
    }));
    
    res.json({
        totalSessions: sessions.length,
        sessions: sessions
    });
});

/**
 * Clear all sessions
 */
app.post('/sessions/clear', (req, res) => {
    const count = activeSessions.size;
    activeSessions.clear();
    res.json({
        success: true,
        message: `Cleared ${count} sessions`,
        timestamp: new Date().toISOString()
    });
});

/**
 * Main webhook endpoint for Trillion
 */
app.post('/webhook/trillion', async (req, res) => {
    try {
        // Accept x-www-form-urlencoded body
        const { from, to, language, timestamp, message } = req.body;

        // Optionally, verify webhook signature if secret is configured
        const signature = req.headers['x-trillion-signature'];
        const payload = JSON.stringify(req.body);
        if (TRILLION_WEBHOOK_SECRET && !verifyTrillionWebhook(payload, signature)) {
            console.error('Invalid webhook signature');
            return res.status(401).json({ error: 'Invalid signature' });
        }

        // Map incoming fields to internal structure
        const webhookData = {
            user_id: from || 'unknown_user',
            channel_id: to || 'tricia@susmaninsurance.com',
            message: message,
            timestamp: timestamp,
            event_type: 'message',
            user_name: from || 'Unknown User',
            language: language || 'en'
        };

        // Process the webhook
        const result = await processTrillionWebhook(webhookData);

        // Respond with text/plain and content-length
        let responseText;
        if (result.success) {
            responseText = result.gptResponse || 'No response';
            res.set('Content-Type', 'text/plain');
            res.set('Content-Length', Buffer.byteLength(responseText, 'utf8'));
            res.status(200).send(responseText);
        } else {
            responseText = result.error || 'Internal server error';
            res.set('Content-Type', 'text/plain');
            res.set('Content-Length', Buffer.byteLength(responseText, 'utf8'));
            res.status(500).send(responseText);
        }
    } catch (error) {
        console.error('Error handling Trillion webhook:', error.message);
        const responseText = 'Internal server error';
        res.set('Content-Type', 'text/plain');
        res.set('Content-Length', Buffer.byteLength(responseText, 'utf8'));
        res.status(500).send(responseText);
    }
});

/**
 * Test endpoint to simulate a Trillion webhook
 */
app.post('/test/webhook', async (req, res) => {
    const testData = {
        user_id: req.body.user_id || 'test_user_123',
        channel_id: req.body.channel_id || 'test_channel_456',
        message: req.body.message || 'Hello, this is a test message',
        timestamp: new Date().toISOString(),
        event_type: 'message',
        user_name: req.body.user_name || 'Test User'
    };
    
    console.log('Processing test webhook...');
    const result = await processTrillionWebhook(testData);
    res.json(result);
});

/**
 * Manual session creation endpoint
 */
app.post('/sessions/create', async (req, res) => {
    try {
        const { user_id, channel_id, user_name } = req.body;
        
        if (!user_id || !channel_id) {
            return res.status(400).json({
                success: false,
                error: 'user_id and channel_id are required'
            });
        }
        
        const sessionUid = await createYourGPTSession();
        const sessionKey = `${user_id}_${channel_id}`;
        
        activeSessions.set(sessionKey, {
            sessionUid,
            userId: user_id,
            channelId: channel_id,
            userName: user_name || 'Manual User',
            createdAt: new Date(),
            lastActivity: new Date()
        });
        
        res.json({
            success: true,
            sessionKey,
            sessionUid,
            message: 'Session created successfully'
        });
        
    } catch (error) {
        console.error('Error creating manual session:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

// Cleanup old sessions periodically (every 30 minutes)
setInterval(() => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    let cleanedCount = 0;
    for (const [key, session] of activeSessions.entries()) {
        if (session.lastActivity < oneHourAgo) {
            activeSessions.delete(key);
            cleanedCount++;
        }
    }
    
    if (cleanedCount > 0) {
        console.log(`Cleaned up ${cleanedCount} inactive sessions`);
    }
}, 30 * 60 * 1000); // 30 minutes

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
    console.log(`📡 Trillion webhook endpoint: http://localhost:${PORT}/webhook/trillion`);
    console.log(`🧪 Test endpoint: http://localhost:${PORT}/test/webhook`);
    console.log(`❤️  Health check: http://localhost:${PORT}/health`);
    console.log(`📊 Sessions info: http://localhost:${PORT}/sessions`);
});

module.exports = app;