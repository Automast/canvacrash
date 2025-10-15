const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const geoip = require('geoip-lite');

const app = express();

// Middleware
app.use(cors()); // Open CORS for all domains
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Environment variables
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FETCHAPP_KEY = process.env.FETCHAPP_KEY;
const FETCHAPP_TOKEN = process.env.FETCHAPP_TOKEN;
const FETCHAPP_URL = process.env.FETCHAPP_URL; // e.g., yourstore.fetchapp.com
const PRODUCT_SKU = process.env.PRODUCT_SKU || 'DIGITAL_COURSE';
const PORT = process.env.PORT || 3000;

// ============= PAYSTACK ENDPOINTS =============

// Initialize Paystack payment
app.post('/api/initialize-payment', async (req, res) => {
    try {
        console.log('=== INITIALIZE PAYMENT REQUEST ===');
        const { email, fullName, amount, gclid } = req.body;
        console.log('Request data:', { email, fullName, amount, gclid });

        if (!email || !fullName || !amount) {
            console.error('Missing required fields');
            return res.status(400).json({
                success: false,
                message: 'Email, full name, and amount are required'
            });
        }

        // Generate unique reference
        const reference = `REF_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        console.log('Generated reference:', reference);

        // Initialize Paystack transaction
        const response = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: email,
                amount: amount * 100, // Convert to kobo (Paystack uses lowest currency unit)
                reference: reference,
                currency: 'NGN',
                callback_url: `${req.headers.origin}/paycomplete.html`,
                metadata: {
                    full_name: fullName,
                    gclid: gclid || 'not_available',
                    custom_fields: [
                        {
                            display_name: 'Customer Name',
                            variable_name: 'customer_name',
                            value: fullName
                        }
                    ]
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.status) {
            console.log('Payment initialized successfully');
            res.json({
                success: true,
                data: {
                    authorization_url: response.data.data.authorization_url,
                    access_code: response.data.data.access_code,
                    reference: reference
                }
            });
        } else {
            console.error('Paystack initialization failed:', response.data);
            res.status(400).json({
                success: false,
                message: 'Failed to initialize payment'
            });
        }
    } catch (error) {
        console.error('Payment initialization error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: 'An error occurred while initializing payment',
            error: error.message
        });
    }
});

// Verify Paystack payment
app.get('/api/verify-payment/:reference', async (req, res) => {
    try {
        console.log('=== VERIFY PAYMENT REQUEST ===');
        const { reference } = req.params;
        console.log('Verifying reference:', reference);

        const response = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
                }
            }
        );

        if (response.data.status) {
            console.log('Payment verified successfully:', response.data.data.status);
            res.json({
                success: true,
                data: response.data.data
            });
        } else {
            console.error('Payment verification failed');
            res.status(400).json({
                success: false,
                message: 'Payment verification failed'
            });
        }
    } catch (error) {
        console.error('Payment verification error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: 'An error occurred while verifying payment'
        });
    }
});

// ============= PAYSTACK WEBHOOK =============

app.post('/api/paystack/webhook', async (req, res) => {
    try {
        console.log('=== WEBHOOK RECEIVED ===');
        
        // Verify Paystack signature
        const hash = crypto
            .createHmac('sha512', PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest('hex');

        const signature = req.headers['x-paystack-signature'];

        if (hash !== signature) {
            console.error('Invalid Paystack signature');
            return res.sendStatus(401);
        }

        const event = req.body;
        console.log('Webhook event:', event.event);

        // Handle successful charge
        if (event.event === 'charge.success') {
            const { reference, customer, metadata, amount, paid_at } = event.data;
            console.log('Payment successful via webhook:', reference);
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error);
        res.sendStatus(500);
    }
});

// ============= POST-PAYMENT PROCESSING =============

app.post('/api/process-order', async (req, res) => {
    console.log('\n=== PROCESS ORDER REQUEST RECEIVED ===');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    try {
        const { email, fullName, reference, gclid, ipAddress, country } = req.body;

        if (!email || !fullName || !reference) {
            console.error('Missing required fields:', { email: !!email, fullName: !!fullName, reference: !!reference });
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }

        console.log('Processing order for:', email);

        // Get IP geolocation if not provided
        let userCountry = country || 'Unknown';
        let userIP = ipAddress || 'Unknown';

        if (!userCountry && ipAddress) {
            try {
                const geo = geoip.lookup(ipAddress);
                userCountry = geo ? geo.country : 'Unknown';
                console.log('GeoIP lookup result:', userCountry);
            } catch (geoError) {
                console.error('GeoIP error:', geoError.message);
            }
        }

        let telegramSuccess = false;
        let fetchAppSuccess = false;

        // 1. Send to Telegram
        console.log('\n--- Attempting to send to Telegram ---');
        try {
            await sendToTelegram({
                email,
                fullName,
                reference,
                gclid: gclid || 'not_available',
                ipAddress: userIP,
                country: userCountry,
                timestamp: new Date().toISOString()
            });
            telegramSuccess = true;
            console.log('✓ Telegram notification sent successfully');
        } catch (telegramError) {
            console.error('✗ Telegram notification failed:', telegramError.message);
            console.error('Telegram error details:', telegramError.response?.data || telegramError);
        }

        // 2. Send to FetchApp (creates order and sends email with download link)
        console.log('\n--- Attempting to send to FetchApp ---');
        try {
            await sendToFetchApp({
                email,
                fullName,
                reference
            });
            fetchAppSuccess = true;
            console.log('✓ FetchApp order created successfully');
        } catch (fetchAppError) {
            console.error('✗ FetchApp order creation failed:', fetchAppError.message);
            console.error('FetchApp error details:', fetchAppError.response?.data || fetchAppError);
        }

        console.log('\n--- Order Processing Summary ---');
        console.log('Telegram:', telegramSuccess ? '✓ SUCCESS' : '✗ FAILED');
        console.log('FetchApp:', fetchAppSuccess ? '✓ SUCCESS' : '✗ FAILED');
        console.log('================================\n');

        res.json({
            success: true,
            message: 'Order processed successfully',
            telegramSuccess,
            fetchAppSuccess
        });
    } catch (error) {
        console.error('✗ Order processing error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({
            success: false,
            message: 'Failed to process order',
            error: error.message
        });
    }
});

// ============= TELEGRAM FUNCTION =============

async function sendToTelegram(data) {
    console.log('Sending to Telegram...');
    console.log('Bot Token:', TELEGRAM_BOT_TOKEN ? 'SET' : 'NOT SET');
    console.log('Chat ID:', TELEGRAM_CHAT_ID ? 'SET' : 'NOT SET');

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        throw new Error('Telegram credentials not configured');
    }

    const message = `
🎉 *NEW SALE - DIGITAL COURSE* 🎉

👤 *Customer:* ${data.fullName}
📧 *Email:* ${data.email}

💰 *Transaction Reference:* ${data.reference}
🔗 *GCLID:* ${data.gclid || 'Not Available'}

🌍 *Country:* ${data.country || 'Unknown'}
🖥️ *IP Address:* ${data.ipAddress || 'Unknown'}
⏰ *Timestamp:* ${data.timestamp}

━━━━━━━━━━━━━━━━━━━━
📊 *Google Ads Conversion Data:*
GCLID: ${data.gclid || 'N/A'}
Email: ${data.email}
Conversion Time: ${data.timestamp}
Conversion Value: NGN 4900
Currency: NGN

*Upload this to Google Ads:*
Format: GCLID, Conversion Name, Conversion Time, Conversion Value, Conversion Currency
Data: ${data.gclid}, purchase, ${data.timestamp}, 4900, NGN
    `.trim();

    const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    console.log('Telegram URL:', telegramUrl.replace(TELEGRAM_BOT_TOKEN, 'HIDDEN'));
    console.log('Sending message...');

    const response = await axios.post(telegramUrl, {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
    });

    console.log('Telegram response:', response.data);

    if (!response.data.ok) {
        throw new Error('Telegram API returned not ok');
    }
}

// ============= FETCHAPP FUNCTION =============

async function sendToFetchApp(data) {
    console.log('Sending to FetchApp...');
    console.log('FetchApp Key:', FETCHAPP_KEY ? 'SET' : 'NOT SET');
    console.log('FetchApp Token:', FETCHAPP_TOKEN ? 'SET' : 'NOT SET');
    console.log('FetchApp URL:', FETCHAPP_URL || 'NOT SET');

    if (!FETCHAPP_KEY || !FETCHAPP_TOKEN || !FETCHAPP_URL) {
        throw new Error('FetchApp credentials not configured');
    }

    const auth = Buffer.from(`${FETCHAPP_KEY}:${FETCHAPP_TOKEN}`).toString('base64');

    const nameParts = data.fullName.split(' ');
    const firstName = nameParts[0] || data.fullName;
    const lastName = nameParts.slice(1).join(' ') || firstName;

    // Create FetchApp order (this will automatically send email with download link)
    const orderData = `<?xml version="1.0" encoding="UTF-8"?>
        <order>
            <id>${data.reference}</id>
            <vendor_id>${data.reference}</vendor_id>
            <first_name>${firstName}</first_name>
            <last_name>${lastName}</last_name>
            <email>${data.email}</email>
            <order_items type="array">
                <order_item>
                    <sku>${PRODUCT_SKU}</sku>
                    <price>4900</price>
                </order_item>
            </order_items>
        </order>`;

    console.log('FetchApp order data:', orderData);

    const response = await axios.post(
        `https://${FETCHAPP_URL}/api/v2/orders/create`,
        orderData,
        {
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/xml'
            }
        }
    );

    console.log('FetchApp response status:', response.status);
    console.log('FetchApp response:', response.data);

    return response.data;
}

// ============= HEALTH CHECK =============

app.get('/health', (req, res) => {
    console.log('Health check called');
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        config: {
            paystack: !!PAYSTACK_SECRET_KEY,
            telegram: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
            fetchapp: !!(FETCHAPP_KEY && FETCHAPP_TOKEN && FETCHAPP_URL)
        }
    });
});

// Test endpoint to verify order processing
app.get('/api/test-process', async (req, res) => {
    console.log('=== TEST PROCESS ORDER ===');
    
    const testData = {
        email: '[email protected]',
        fullName: 'Test User',
        reference: 'TEST_' + Date.now(),
        gclid: 'test_gclid_123',
        ipAddress: '8.8.8.8',
        country: 'Nigeria'
    };
    
    console.log('Test data:', testData);
    
    try {
        // Test Telegram
        console.log('\nTesting Telegram...');
        await sendToTelegram({
            ...testData,
            timestamp: new Date().toISOString()
        });
        
        // Test FetchApp
        console.log('\nTesting FetchApp...');
        await sendToFetchApp(testData);
        
        res.json({
            success: true,
            message: 'Test completed - check logs'
        });
    } catch (error) {
        console.error('Test failed:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log('\n========================================');
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log('========================================');
    console.log('\nConfiguration Check:');
    console.log('Paystack Secret Key:', PAYSTACK_SECRET_KEY ? '✓ SET' : '✗ NOT SET');
    console.log('Telegram Bot Token:', TELEGRAM_BOT_TOKEN ? '✓ SET' : '✗ NOT SET');
    console.log('Telegram Chat ID:', TELEGRAM_CHAT_ID ? '✓ SET' : '✗ NOT SET');
    console.log('FetchApp Key:', FETCHAPP_KEY ? '✓ SET' : '✗ NOT SET');
    console.log('FetchApp Token:', FETCHAPP_TOKEN ? '✓ SET' : '✗ NOT SET');
    console.log('FetchApp URL:', FETCHAPP_URL ? '✓ SET' : '✗ NOT SET');
    console.log('========================================\n');
});
