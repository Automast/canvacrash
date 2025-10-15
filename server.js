const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
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

// --- Sender.net (email delivery via welcome automation) ---
const SENDER_API_KEY = process.env.SENDER_API_KEY;
const SENDER_GROUP_ID = process.env.SENDER_GROUP_ID; // Group that triggers the welcome email
const USE_FETCHAPP = (process.env.USE_FETCHAPP || 'false').toLowerCase() === 'true';

// Course details
const DOWNLOAD_URL = 'https://learnlist.fetchapp.com/permalink/6c088fc7';
const COURSE_TITLE = process.env.COURSE_TITLE || 'Your Course';

// HTML escape helper for Telegram HTML parse_mode
const esc = (s = '') => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// Helper to parse boolean strings
function bool(v) { 
  return String(v).toLowerCase() === 'true'; 
}

// Create SMTP transporter (reusable)
function createTransporter() {
  return nodemailer.createTransporter({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: bool(process.env.SMTP_SECURE || 'true'), // true for 465, false for 587
    auth: { 
      user: process.env.SMTP_USER, 
      pass: process.env.SMTP_PASS 
    }
  });
}

// Test SMTP connection on startup
async function testSMTPConnection() {
  console.log('\n📧 Testing SMTP connection...');
  console.log('==========================================');
  console.log(`Host: ${process.env.SMTP_HOST}`);
  console.log(`Port: ${process.env.SMTP_PORT || 465}`);
  console.log(`User: ${process.env.SMTP_USER}`);
  console.log(`Secure: ${bool(process.env.SMTP_SECURE || 'true')}`);
  console.log('==========================================\n');

  try {
    const transporter = createTransporter();
    await transporter.verify();
    console.log('✅ SMTP CONNECTION SUCCESSFUL!');
    console.log('✅ Email service is ready to send emails\n');
    return true;
  } catch (error) {
    console.error('❌ SMTP CONNECTION FAILED!');
    console.error('❌ Error:', error.message);
    console.error('\n⚠️  Please check your SMTP credentials in .env file');
    console.error('⚠️  Server will continue running but emails will NOT be sent!\n');
    return false;
  }
}

// SMTP email sender using Nodemailer
async function sendDownloadEmailSMTP({ fullName, email, downloadUrl, reference, courseTitle }) {
  console.log('\n📨 Attempting to send email...');
  console.log(`   To: ${email}`);
  console.log(`   Name: ${fullName}`);
  console.log(`   Reference: ${reference}`);
  
  try {
    const transporter = createTransporter();
    
    const safeName = (fullName || 'there').trim();
    const subject = `${courseTitle}: Your download link (Order ${reference})`;

    const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;line-height:1.6;color:#111">
    <h2 style="margin:0 0 12px">Payment confirmed ✅</h2>
    <p>Dear ${safeName},</p>
    <p>Thanks for your purchase of <strong>${courseTitle}</strong>. Your download link is below:</p>
    <p>
      <a href="${downloadUrl}" 
         style="background:#1a56db;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;display:inline-block">
        Download your course
      </a>
    </p>
    <p>If the button above doesn't work, copy &amp; paste this link:<br>
      <a href="${downloadUrl}">${downloadUrl}</a>
    </p>
    <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
    <p style="font-size:13px;color:#555">Order ref: <strong>${reference}</strong></p>
    <p style="font-size:12px;color:#777">This is a transactional email sent automatically after your purchase.</p>
  </div>`.trim();

    const text = [
      `Payment confirmed`,
      ``,
      `Dear ${safeName},`,
      `Thanks for your purchase of ${courseTitle}.`,
      `Download link: ${downloadUrl}`,
      ``,
      `Order ref: ${reference}`,
    ].join('\n');

    const info = await transporter.sendMail({
      from: { 
        name: process.env.FROM_NAME || 'Learnlist', 
        address: process.env.FROM_EMAIL 
      },
      to: [{ name: safeName, address: email }],
      subject,
      text,
      html,
      headers: {
        'X-Entity-Ref-ID': reference,       // helps threading
        'X-Transactional': 'true'           // hint this is transactional
      }
    });

    console.log('✅ EMAIL SENT SUCCESSFULLY!');
    console.log(`   Message ID: ${info.messageId}`);
    console.log(`   Response: ${info.response}`);
    console.log(`   Accepted: ${info.accepted?.join(', ') || 'N/A'}`);
    if (info.rejected?.length > 0) {
      console.log(`   Rejected: ${info.rejected.join(', ')}`);
    }
    console.log('');
    
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('❌ EMAIL SENDING FAILED!');
    console.error(`   Error: ${error.message}`);
    if (error.code) {
      console.error(`   Error Code: ${error.code}`);
    }
    if (error.command) {
      console.error(`   Command: ${error.command}`);
    }
    console.error('');
    throw error; // Re-throw to handle in calling function
  }
}

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

        // Format message for easy Google Ads upload (Telegram HTML)
        const message = [
            '🎉 <b>NEW CONVERSION</b> 🎉',
            '',
            '<b>Customer Details:</b>',
            `Full Name: ${esc(fullName)}`,
            `Email: ${esc(email)}`,
            '',
            '<b>Transaction Details:</b>',
            `Amount: ${esc('₦' + String(amount))}`,
            `Reference: ${esc(reference)}`,
            `Country: ${esc(country || 'NG')}`,
            `IP Address: ${esc(ip || 'N/A')}`,
            '',
            '<b>Google Ads Data:</b>',
            `GCLID: ${esc(gclid || 'direct')}`,
            `Conversion Time: ${esc(new Date().toISOString())}`,
            '',
            '<b>For Google Ads Upload:</b>',
            `<pre>GCLID: ${esc(gclid || 'direct')}
Conversion Name: Purchase
Conversion Time: ${esc(new Date().toISOString())}
Conversion Value: ${esc(String(amount))}
Conversion Currency: NGN</pre>`
        ].join('\n');

        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML',
                disable_web_page_preview: true
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

// --- Idempotency cache for processed references (in-memory) ---
const processedReferences = new Set();

// Add a buyer to Sender list/group so their Welcome email goes out automatically
async function addSubscriberToSender({ email, fullName, gclid = 'direct' }) {
  try {
    if (!SENDER_API_KEY || !SENDER_GROUP_ID) {
      console.warn('Sender.net not configured (missing SENDER_API_KEY or SENDER_GROUP_ID). Skipping.');
      return { skipped: true };
    }
    const [first_name, ...rest] = String(fullName || '').trim().split(' ');
    const last_name = rest.join(' ') || '';
    // Minimal, safe payload: email + name + group assignment.
    // (Your Welcome workflow should be set to trigger on "Subscriber added to a group".)
    await axios.post(
      'https://api.sender.net/subscribers',
      {
        email,
        first_name,
        last_name,
        groups: [SENDER_GROUP_ID],
        // You can store extras as tags; create tags in Sender if you like.
        tags: ['customer', 'paystack', gclid ? `gclid:${gclid}` : 'gclid:none']
      },
      {
        headers: {
          Authorization: `Bearer ${SENDER_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        }
      }
    );
    return { success: true };
  } catch (err) {
    // Log full API error body to help troubleshooting (401/404/etc)
    console.error('Sender subscribe error:', err.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

// --- Shared processor: send Telegram, add to Sender, optionally create FetchApp order ---
async function handleSuccessfulPayment({
  reference,
  email,
  fullName,
  amountNaira,
  currency = 'NGN',
  gclid = 'direct',
  ipAddress = 'N/A',
  country = 'NG'
}) {
  console.log('\n🔄 Processing payment...');
  console.log(`   Reference: ${reference}`);
  console.log(`   Customer: ${fullName} (${email})`);
  console.log(`   Amount: ${currency} ${amountNaira}`);
  
  if (processedReferences.has(reference)) {
    console.log('⚠️  Payment already processed (duplicate prevented)');
    return { alreadyProcessed: true };
  }

  try {
    // 1) Telegram (HTML, safely escaped)
    console.log('\n📱 Sending Telegram notification...');
    const message = [
      '🎉 <b>NEW CONVERSION</b> 🎉',
      '',
      '<b>Customer Details:</b>',
      `Full Name: ${esc(fullName)}`,
      `Email: ${esc(email)}`,
      '',
      '<b>Transaction Details:</b>',
      `Amount: ${esc(`${currency} ${amountNaira}`)}`,
      `Reference: ${esc(reference)}`,
      `Country: ${esc(country)}`,
      `IP Address: ${esc(ipAddress)}`,
      '',
      '<b>Google Ads Data:</b>',
      `GCLID: ${esc(gclid)}`,
      `Conversion Time: ${esc(new Date().toISOString())}`,
      '',
      '<b>For Google Ads Upload:</b>',
      `<pre>GCLID: ${esc(gclid)}
Conversion Name: Purchase
Conversion Time: ${esc(new Date().toISOString())}
Conversion Value: ${esc(String(amountNaira))}
Conversion Currency: ${esc(currency)}</pre>`
    ].join('\n');

    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true }
    );
    console.log('✅ Telegram notification sent successfully');

    // 2) Add to Sender.net so the Welcome email (with download link) is sent automatically
    await addSubscriberToSender({ email, fullName, gclid });

    // 3) Optional: FetchApp (off by default; free plan returns 404)
    if (USE_FETCHAPP) {
      const nameParts = (fullName || '').trim().split(' ');
      const firstName = nameParts[0] || 'Customer';
      const lastName = nameParts.slice(1).join(' ') || 'Customer';
      const fetchAuth = Buffer.from(`${FETCHAPP_KEY}:${FETCHAPP_TOKEN}`).toString('base64');
      await axios.post(
        `${FETCHAPP_URL}/api/v2/orders`,
        {
          order: {
            vendor_id: reference,
            first_name: firstName,
            last_name: lastName,
            email: email,
            order_items: [{ sku: PRODUCT_SKU }],
            send_email: true
          }
        },
        {
          headers: {
            Authorization: `Basic ${fetchAuth}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          }
        }
      );
    } else {
      console.log('FetchApp disabled. Using Sender.net automation for delivery.');
    }

    processedReferences.add(reference);
    console.log('✅ Payment processing completed successfully!\n');
    
    return { alreadyProcessed: false };
  } catch (error) {
    console.error('❌ Error during payment processing:', error.message);
    throw error;
  }
}

// --- New: Orchestrator endpoint the frontend calls from paycomplete.html ---
app.post('/api/process-order', async (req, res) => {
    try {
        const { email, fullName, reference, gclid, ipAddress, country } = req.body;
        if (!email || !fullName || !reference) {
            return res.status(400).json({ success: false, message: 'Missing email, fullName or reference' });
        }

        // Verify the transaction status via Paystack (required best-practice)
        const verify = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
        );

        const data = verify.data?.data;
        if (!(verify.data?.status && data?.status === 'success')) {
            return res.status(400).json({ success: false, message: 'Verification failed' });
        }

        // Convert kobo -> naira
        const amountNaira = Math.round(Number(data.amount) || 0) / 100;
        const currency = data.currency || 'NGN';

        const result = await handleSuccessfulPayment({
            reference,
            email,
            fullName,
            amountNaira,
            currency,
            gclid,
            ipAddress,
            country
        });

        return res.json({
            success: true,
            message: result.alreadyProcessed ? 'Already processed' : 'Processed',
            emailSent: result.emailSent || false
        });
    } catch (error) {
        console.error('process-order error:', error.response?.data || error.message);
        return res.status(500).json({ 
            success: false, 
            message: 'Server error', 
            error: error.message 
        });
    }
});

// --- Enhanced webhook: also calls the shared processor (server-side fallback) ---
app.post('/api/webhook/paystack', (req, res) => {
    try {
        const hash = crypto
            .createHmac('sha512', PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body)) // works if body-parser hasn't altered key order
            .digest('hex');

        if (hash !== req.headers['x-paystack-signature']) {
            console.log('❌ Invalid webhook signature');
            return res.sendStatus(400);
        }

        const event = req.body;
        if (event?.event === 'charge.success') {
            const ref = event.data?.reference;
            console.log('\n🔔 Webhook received: Payment successful');
            console.log(`   Reference: ${ref}`);

            // Pull details from event payload
            const email = event.data?.customer?.email || event.data?.authorization?.email;
            const fullName = event.data?.metadata?.full_name || `${event.data?.customer?.first_name || ''} ${event.data?.customer?.last_name || ''}`.trim() || 'Customer';
            const gclid = event.data?.metadata?.gclid || 'direct';
            const amountNaira = Math.round(Number(event.data?.amount) || 0) / 100;
            const currency = event.data?.currency || 'NGN';
            const ipAddress = event.data?.ip_address || req.ip;
            const country = event.data?.customer?.country || 'NG';

            // Fire and forget; don't block the webhook response
            handleSuccessfulPayment({
                reference: ref,
                email,
                fullName,
                amountNaira,
                currency,
                gclid,
                ipAddress,
                country
            }).catch(err => {
                const resp = err.response;
                console.error('Webhook processing error:', {
                    status: resp?.status,
                    statusText: resp?.statusText,
                    data: resp?.data || err.message
                });
            });
        }

        return res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error);
        return res.sendStatus(500);
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

// Start server with SMTP test
async function startServer() {
    // Test SMTP connection before starting
    await testSMTPConnection();
    
    app.listen(PORT, () => {
        console.log('==========================================');
        console.log(`🚀 Server is running on port ${PORT}`);
        console.log(`🏥 Health check: http://localhost:${PORT}/api/health`);
        console.log('==========================================\n');
    });
}

// Start the server
startServer().catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
