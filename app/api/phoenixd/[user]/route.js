// This endpoint serves as the notifier for phoenixd webhooks!
// Be sure to place your webhook-secret in env.PHOENIXD_WEBHOOK_SECRET
// In phoenix.conf, add the following line to turn on webhooks:
// webhook=https://yourdomain.com/api/phoenixd/hook

const crypto = require('crypto');
const axios = require('axios');
import nodemailer from 'nodemailer';
import { NextResponse } from 'next/server';

// Optional email copy of each payment, using the same EMAIL_* variables the old notifier used.
function emailNotification(subject, html) {
  const { EMAIL_SENDER, EMAIL_PASSWORD, EMAIL_RECIPIENT, EMAIL_BCC } = process.env;
  if (!EMAIL_SENDER || !EMAIL_PASSWORD || !EMAIL_RECIPIENT) return;
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_SENDER, pass: EMAIL_PASSWORD } });
  transporter.sendMail({ from: EMAIL_SENDER, to: EMAIL_RECIPIENT, bcc: EMAIL_BCC || undefined, subject, html }, (error, info) => {
    if (error) console.log(`Mail error: ${error}`);
    else console.log(`Email sent: ${info.response}`);
  });
}

function pushNotification(subject, body) {
  axios.post('https://api.pushover.net/1/messages.json', {
    token: process.env.PUSHOVER_TOKEN,
    user:  process.env.PUSHOVER_USER,
    title: subject,
    message: body,
    html: 1
  })
  .then(response => {
    console.log('Push notification sent:', response.data);
  })
  .catch(error => {
    console.error('Error sending push notification:', error);
  });
}

export async function POST(req) {
  console.log("Welcome to the phoenixd webhook route!");

  try {
    const bodyRaw = await req.text();
    const bodyJSON = JSON.parse(bodyRaw);
    console.log('Webhook received:', bodyJSON);

    // Calculate the HMAC SHA256 hash
    const secret = Buffer.from(process.env.PHOENIXD_WEBHOOK_SECRET, 'utf8');
    const signature = req.headers.get('x-phoenix-signature');
    const hash = crypto.createHmac('sha256', secret)
                      .update(bodyRaw)
                      .digest('hex');

    if (crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(hash, 'hex'))) {
      // Signature was valid!
      let type = bodyJSON?.type;
      let amount = Number(bodyJSON?.amountSat);
      let plural = amount > 1 ? 's' : '';
      amount = amount.toLocaleString();

      if (type == 'payment_received') {
        const externalId = bodyJSON?.externalId ? ` for ${bodyJSON.externalId}` : '';
        let subject = `You got paid ${amount} sat${plural} via phoenixd!`;
        let message = `Amount: ${amount} sat${plural}${externalId} <br><br>Received via <b>phoenixd</b> 🪽`;
        pushNotification(subject, message);
        emailNotification(subject, message);
      }
    } else {
      console.log('Invalid signature.');
    }
  } catch (error) {
    console.error('Error processing webhook:', error);
    return NextResponse.json({ message: 'Error processing webhook.', error: error.message });
  }

  return NextResponse.json({ message: 'Webhook received loud and clear!' });
}
