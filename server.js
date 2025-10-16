const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { MailerSend, EmailParams, Sender, Recipient } = require('mailersend');
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

// MailerSend configuration
const MAILERSEND_API_KEY = process.env.MAILERSEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL; // Must match verified domain
const FROM_NAME = process.env.FROM_NAME || 'Learnlist';

// Course details
const DOWNLOAD_URL = 'http://learnlist.info/course.html';
const COURSE_TITLE = process.env.COURSE_TITLE || 'Your Course';

// HTML escape helper for Telegram HTML parse_mode
const esc = (s = '') => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// Initialize MailerSend client
let mailerSend = null;

// Test MailerSend connection on startup
async function testMailerSendConnection() {
  console.log('\n📧 Testing MailerSend connection...');
  console.log('==========================================');
  console.log(`API Key: ${MAILERSEND_API_KEY ? 'Present (' + MAILERSEND_API_KEY.substring(0, 8) + '...)' : 'Missing'}`);
  console.log(`From Email: ${FROM_EMAIL || 'Missing'}`);
  console.log(`From Name: ${FROM_NAME || 'Missing'}`);
  console.log('==========================================\n');

  try {
    if (!MAILERSEND_API_KEY) {
      throw new Error('MAILERSEND_API_KEY is required - get it from MailerSend dashboard');
    }

    if (!FROM_EMAIL) {
      throw new Error('FROM_EMAIL is required and must match your verified domain');
    }

    // Check if API key format looks correct
    if (!MAILERSEND_API_KEY.startsWith('mlsn.')) {
      console.warn('⚠️  WARNING: API key should start with "mlsn." - please verify your API key');
    }

    // Initialize MailerSend client
    mailerSend = new MailerSend({
      apiKey: MAILERSEND_API_KEY,
    });

    console.log('✅ MAILERSEND CLIENT INITIALIZED!');
    console.log('✅ Email service is ready to send emails');
    console.log('⚠️  Make sure your domain is verified in MailerSend dashboard');
    console.log(`⚠️  Make sure FROM_EMAIL (${FROM_EMAIL}) matches your verified domain\n`);
    return true;
  } catch (error) {
    console.error('❌ MAILERSEND SETUP FAILED!');
    console.error('❌ Error:', error.message);
    console.error('\n📋 SETUP CHECKLIST:');
    console.error('   1. Create account at https://mailersend.com');
    console.error('   2. Add and verify your domain');
    console.error('   3. Generate API token from domain settings');
    console.error('   4. Set MAILERSEND_API_KEY in .env file');
    console.error('   5. Set FROM_EMAIL to match verified domain');
    console.error('\n⚠️  Server will continue running but emails will NOT be sent!\n');
    return false;
  }
}

// Email sender using MailerSend API
async function sendDownloadEmailMailerSend({ fullName, email, downloadUrl, reference, courseTitle }) {
  console.log('\n📨 Attempting to send email via MailerSend...');
  console.log(`   To: ${email}`);
  console.log(`   Name: ${fullName}`);
  console.log(`   Reference: ${reference}`);
  
  try {
    if (!mailerSend) {
      throw new Error('MailerSend client not initialized');
    }

    const safeName = (fullName || 'there').trim();
    const subject = `${courseTitle}: Your download link (Order ${reference})`;

    const htmlContent = `
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

    const textContent = [
      `Payment confirmed`,
      ``,
      `Dear ${safeName},`,
      `Thanks for your purchase of ${courseTitle}.`,
      `Download link: ${downloadUrl}`,
      ``,
      `Order ref: ${reference}`,
    ].join('\n');

    // Create email parameters
    const sentFrom = new Sender(FROM_EMAIL, FROM_NAME);
    const recipients = [new Recipient(email, safeName)];

    const emailParams = new EmailParams()
      .setFrom(sentFrom)
      .setTo(recipients)
      .setSubject(subject)
      .setHtml(htmlContent)
      .setText(textContent);

    // Send the email - MailerSend returns response with .body property
    const response = await mailerSend.email.send(emailParams);

    console.log('✅ EMAIL SENT SUCCESSFULLY!');
    console.log(`   Status: ${response.status || 'N/A'}`);
    console.log(`   Status Text: ${response.statusText || 'N/A'}`);
    
    // MailerSend returns message ID in response headers
    const messageId = response.headers ? response.headers['x-message-id'] : null;
    if (messageId) {
      console.log(`   Message ID: ${messageId}`);
    }
    
    // Log response body if available
    if (response.body) {
      console.log(`   Response Body:`, response.body);
    }
    
    console.log('');
    
    return { 
      success: true, 
      messageId: messageId || 'sent',
      status: response.status,
      response: response
    };
  } catch (error) {
    console.error('❌ EMAIL SENDING FAILED!');
    
    // MailerSend errors have .body property
    if (error.body) {
      console.error(`   Error Body:`, error.body);
    }
    
    if (error.message) {
      console.error(`   Error Message: ${error.message}`);
    }
    
    if (error.status) {
      console.error(`   Status: ${error.status}`);
    }
    
    if (error.statusText) {
      console.error(`   Status Text: ${error.statusText}`);
    }
    
    // Log the full error for debugging
    console.error(`   Full Error:`, error);
    
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

        // 2) Send the download email via MailerSend API
        const emailResult = await sendDownloadEmailMailerSend({
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
        timestamp: new Date().toISOString(),
        mailersend: {
            configured: !!mailerSend,
            apiKey: !!MAILERSEND_API_KEY,
            fromEmail: !!FROM_EMAIL
        }
    });
});

// Test email endpoint for debugging
app.post('/api/test-email', async (req, res) => {
    try {
        const { email, name } = req.body;
        
        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }

        console.log('\n🧪 Testing email sending...');
        console.log(`   Test Email: ${email}`);
        console.log(`   Test Name: ${name || 'Test User'}`);

        const result = await sendDownloadEmailMailerSend({
            fullName: name || 'Test User',
            email: email,
            downloadUrl: 'https://example.com/test-download',
            reference: 'TEST_' + Date.now(),
            courseTitle: 'Test Course'
        });

        res.json({
            success: true,
            message: 'Test email sent successfully',
            result: result
        });

    } catch (error) {
        console.error('Test email failed:', error);
        
        res.status(500).json({
            success: false,
            message: 'Test email failed',
            error: {
                message: error.message,
                body: error.body,
                status: error.status,
                statusText: error.statusText
            }
        });
    }
});

// Start server with MailerSend test
async function startServer() {
    // Test MailerSend connection before starting
    await testMailerSendConnection();
    
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
