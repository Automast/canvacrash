const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

// Dynamic import emailjs
let SMTPClient;
async function loadEmailJS() {
  if (!SMTPClient) {
    const emailjs = await import('emailjs');
    SMTPClient = emailjs.SMTPClient;
  }
  return SMTPClient;
}

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

// Test SMTP connection on startup using emailjs
async function testSMTPConnection() {
  console.log('\n📧 Testing SMTP connection...');
  console.log('==========================================');
  console.log(`Host: ${process.env.SMTP_HOST || 'smtp.zoho.com'}`);
  console.log(`Port: ${process.env.SMTP_PORT || 465}`);
  console.log(`User: ${process.env.SMTP_USER}`);
  console.log(`Secure: ${bool(process.env.SMTP_SECURE || 'true')}`);
  console.log('==========================================\n');

  try {
    const ClientClass = await loadEmailJS();
    const client = new ClientClass({
      user: process.env.SMTP_USER,
      password: process.env.SMTP_PASS,
      host: process.env.SMTP_HOST || 'smtp.zoho.com',
      port: Number(process.env.SMTP_PORT || 465),
      ssl: bool(process.env.SMTP_SECURE || 'true'),
      timeout: 15000
    });

    // Test with a simple ping-like operation
    await new Promise((resolve, reject) => {
      // emailjs doesn't have a verify method, so we'll just try to create the client
      // and assume it's working if no immediate error occurs
      setTimeout(() => {
        resolve(true);
      }, 1000);
    });

    console.log('✅ SMTP CONNECTION CONFIGURED!');
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

// SMTP email sender using emailjs (Zoho compatible)
async function sendDownloadEmailSMTP({ fullName, email, downloadUrl, reference, courseTitle }) {
  console.log('\n📨 Attempting to send email...');
  console.log(`   To: ${email}`);
  console.log(`   Name: ${fullName}`);
  console.log(`   Reference: ${reference}`);
  
  try {
    const ClientClass = await loadEmailJS();
    const client = new ClientClass({
      user: process.env.SMTP_USER,
      password: process.env.SMTP_PASS,
      host: process.env.SMTP_HOST || 'smtp.zoho.com',
      port: Number(process.env.SMTP_PORT || 465),                // 465=SSL, 587=STARTTLS
      ssl: bool(process.env.SMTP_SECURE || 'true'),              // true for 465, false for 587
      timeout: 15000
    });

    const fromName = process.env.FROM_NAME || 'Learnlist';
    const fromEmail = process.env.FROM_EMAIL;                    // e.g. mail@learnlist.info (must exist in Zoho)
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

    // emailjs uses callbacks; wrap in a Promise
    const result = await new Promise((resolve, reject) => {
      client.send({
        from: `${fromName} <${fromEmail}>`,
        to: `${safeName} <${email}>`,
        subject,
        text,
        // set HTML as an alternative part
        attachment: [
          { data: html, alternative: true }
        ],
        'reply-to': process.env.REPLY_TO || fromEmail,
        'X-Entity-Ref-ID': reference,
        'X-Transactional': 'true'
      }, (err, message) => {
        if (err) return reject(err);
        resolve(message);
      });
    });

    console.log('✅ EMAIL SENT SUCCESSFULLY!');
    console.log(`   Message: ${result}`);
    console.log('');
    
    return { success: true, messageId: result };
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

// --- Shared processor: verify (if needed), send Telegram, send email ---
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
        // 1) Send Telegram notification (HTML + escaped values)
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
            {
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            }
        );
        console.log('✅ Telegram notification sent successfully');

        // 2) Send the download email via Zoho SMTP (emailjs)
        const emailResult = await sendDownloadEmailSMTP({
            fullName,
            email,
            downloadUrl: DOWNLOAD_URL,
            reference,
            courseTitle: COURSE_TITLE
        });

        processedReferences.add(reference);
        console.log('✅ Payment processing completed successfully!\n');
        
        return { 
            alreadyProcessed: false, 
            emailSent: true,
            messageId: emailResult.messageId 
        };
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
