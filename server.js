const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors()); // Open to all domains for testing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Environment variables needed
const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FETCHAPP_KEY = process.env.FETCHAPP_KEY;
const FETCHAPP_TOKEN = process.env.FETCHAPP_TOKEN;
const FETCHAPP_URL = process.env.FETCHAPP_URL; // e.g., https://yourhandle.fetchapp.com
const PRODUCT_SKU = process.env.PRODUCT_SKU; // Your product SKU in FetchApp

// Initialize Paystack transaction
app.post('/api/initialize-payment', async (req, res) => {
    try {
        const { email, fullName, amount, gclid } = req.body;

        // Validate input
        if (!email || !fullName || !amount) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: email, fullName, amount'
            });
        }

        // Generate unique reference
        const reference = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Initialize Paystack transaction
        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: email,
                amount: amount * 100, // Convert to kobo (smallest unit)
                reference: reference,
                metadata: {
                    full_name: fullName,
                    gclid: gclid || 'direct',
                    custom_fields: [
                        {
                            display_name: "Full Name",
                            variable_name: "full_name",
                            value: fullName
                        }
                    ]
                },
                callback_url: `${req.headers.origin}/paycomplete.html`
            },
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (paystackResponse.data.status) {
            res.json({
                success: true,
                data: {
                    authorization_url: paystackResponse.data.data.authorization_url,
                    access_code: paystackResponse.data.data.access_code,
                    reference: reference
                }
            });
        } else {
            res.status(400).json({
                success: false,
                message: 'Failed to initialize payment'
            });
        }
    } catch (error) {
        console.error('Payment initialization error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: 'Server error during payment initialization',
            error: error.message
        });
    }
});

// Verify Paystack transaction
app.get('/api/verify-payment/:reference', async (req, res) => {
    try {
        const { reference } = req.params;

        const paystackResponse = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
                }
            }
        );

        if (paystackResponse.data.status && paystackResponse.data.data.status === 'success') {
            res.json({
                success: true,
                data: paystackResponse.data.data
            });
        } else {
            res.json({
                success: false,
                message: 'Payment verification failed'
            });
        }
    } catch (error) {
        console.error('Payment verification error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: 'Server error during payment verification',
            error: error.message
        });
    }
});

// Send conversion data to Telegram
app.post('/api/send-telegram-notification', async (req, res) => {
    try {
        const { fullName, email, gclid, amount, reference, country, ip } = req.body;

        // Format message for easy Google Ads upload
        const message = `
🎉 *NEW CONVERSION* 🎉

*Customer Details:*
Full Name: ${fullName}
Email: ${email}

*Transaction Details:*
Amount: ₦${amount}
Reference: ${reference}
Country: ${country || 'NG'}
IP Address: ${ip || 'N/A'}

*Google Ads Data:*
GCLID: ${gclid || 'direct'}
Conversion Time: ${new Date().toISOString()}

*For Google Ads Upload:*
\`\`\`
GCLID: ${gclid || 'direct'}
Conversion Name: Purchase
Conversion Time: ${new Date().toISOString()}
Conversion Value: ${amount}
Conversion Currency: NGN
\`\`\`
        `.trim();

        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'Markdown'
            }
        );

        res.json({ success: true, message: 'Telegram notification sent' });
    } catch (error) {
        console.error('Telegram notification error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to send Telegram notification',
            error: error.message
        });
    }
});

// Create FetchApp order and send email
app.post('/api/create-fetchapp-order', async (req, res) => {
    try {
        const { fullName, email, reference } = req.body;

        // Split name into first and last
        const nameParts = fullName.trim().split(' ');
        const firstName = nameParts[0] || 'Customer';
        const lastName = nameParts.slice(1).join(' ') || 'Customer';

        // Create FetchApp order (using v2 API)
        const fetchAppAuth = Buffer.from(`${FETCHAPP_KEY}:${FETCHAPP_TOKEN}`).toString('base64');

        const orderData = {
            order: {
                vendor_id: reference,
                first_name: firstName,
                last_name: lastName,
                email: email,
                order_items: [
                    {
                        sku: PRODUCT_SKU
                    }
                ],
                send_email: true // FetchApp will send the download email
            }
        };

        const fetchAppResponse = await axios.post(
            `${FETCHAPP_URL}/api/v2/orders`,
            orderData,
            {
                headers: {
                    'Authorization': `Basic ${fetchAppAuth}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            }
        );

        res.json({
            success: true,
            message: 'FetchApp order created and email sent',
            data: fetchAppResponse.data
        });
    } catch (error) {
        console.error('FetchApp order error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to create FetchApp order',
            error: error.response?.data || error.message
        });
    }
});

// Paystack webhook endpoint
app.post('/api/webhook/paystack', (req, res) => {
    try {
        const hash = crypto
            .createHmac('sha512', PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest('hex');

        if (hash === req.headers['x-paystack-signature']) {
            const event = req.body;

            // Handle successful payment event
            if (event.event === 'charge.success') {
                console.log('Payment successful:', event.data.reference);
                // You can add additional webhook processing here
            }

            res.sendStatus(200);
        } else {
            res.sendStatus(400);
        }
    } catch (error) {
        console.error('Webhook error:', error);
        res.sendStatus(500);
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'Server is running',
        timestamp: new Date().toISOString()
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/api/health`);
});