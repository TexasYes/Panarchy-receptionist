/**
 * legal.js — Static Privacy Policy + Terms of Service for the Dialog SMS
 * receptionist line, served from the Railway webhook so we have stable URLs
 * to give to Twilio's A2P 10DLC reviewer (TCR).
 *
 * Routes:
 *   GET /privacy → Privacy Policy
 *   GET /terms   → Terms of Service
 *
 * Both are public, no auth. Mount from index.js with:
 *   require('./legal').mountRoutes(app);
 *
 * Drafted for Twilio/TCR reviewer expectations: SMS program disclosure,
 * STOP/HELP, opt-out method, carrier disclaimer, no third-party data sale,
 * message frequency, contact info on the policy page itself.
 *
 * Effective date: 2026-05-09. Update DOC_DATE when materially editing.
 */

const DOC_DATE = 'May 9, 2026';

const COMPANY_NAME    = 'The Dialog Marketing Group LLC';
const COMPANY_ADDRESS = '908 Congress Avenue, Austin, TX 78701';
const COMPANY_EMAIL   = 'LetsChat@DialogGroup.com';
const SMS_NUMBER      = '+1 (512) 697-9425';
const SMS_NUMBER_RAW  = '5126979425';
const COMPANY_STATE   = 'Texas';
const COMPANY_VENUE   = 'Travis County, Texas';

function htmlPage(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — ${COMPANY_NAME}</title>
  <style>
    :root { --wine: #431031; --gold: #F4A41D; --ink: #222; --muted: #666; --line: #e8e8e8; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
           max-width: 760px; margin: 40px auto 80px; padding: 0 24px; line-height: 1.6; color: var(--ink); }
    h1 { color: var(--wine); border-bottom: 3px solid var(--gold); padding-bottom: 12px; margin-bottom: 8px; }
    h2 { color: var(--wine); margin-top: 36px; font-size: 1.25rem; }
    a { color: var(--wine); }
    .meta { color: var(--muted); font-size: 14px; margin-bottom: 28px; }
    .footer { margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--line);
              color: var(--muted); font-size: 13px; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-size: 0.92em; }
    ul { padding-left: 22px; }
    li { margin: 6px 0; }
  </style>
</head>
<body>
${body}
<p class="footer">© 2026 ${COMPANY_NAME}. All rights reserved.</p>
</body>
</html>`;
}

const PRIVACY_BODY = `
<h1>Privacy Policy</h1>
<p class="meta">Effective date: ${DOC_DATE} · Last updated: ${DOC_DATE}</p>

<p>This Privacy Policy describes how <strong>${COMPANY_NAME}</strong> ("Dialog", "we", "us", or "our") collects, uses, and shares information when you interact with our communications services, including our SMS-based AI receptionist available at <code>${SMS_NUMBER}</code>.</p>

<h2>1. About us</h2>
<p>${COMPANY_NAME} is a ${COMPANY_STATE} limited liability company located at ${COMPANY_ADDRESS}. We are a management consulting firm with operations based in the United States.</p>

<h2>2. Information we collect</h2>
<p>When you contact us through our receptionist line, we collect:</p>
<ul>
  <li><strong>Phone number</strong> — automatically captured when you text or call us; used to identify you across the conversation and to enable callbacks.</li>
  <li><strong>Name and company</strong> — collected when you share them during a call or text conversation.</li>
  <li><strong>Message content</strong> — the text or voice content of your communications with our AI receptionist or our staff.</li>
  <li><strong>Call metadata</strong> — timestamps, call duration, message timestamps, and which Dialog employee was contacted.</li>
</ul>
<p>We do not collect government identifiers, financial account numbers, payment card data, biometric data, or precise location data through this service.</p>

<h2>3. How we use information</h2>
<p>We use the information described above solely to:</p>
<ul>
  <li>Connect you with the appropriate Dialog consultant or take a message on their behalf;</li>
  <li>Send transactional SMS notifications to our staff about incoming inquiries (for example, a brief alert asking a consultant if they are available to take a live call);</li>
  <li>Maintain operational records of who contacted Dialog and when, for client-relationship and accountability purposes.</li>
</ul>
<p>We <strong>do not</strong> use your phone number or contact information for marketing, advertising, or promotional messaging without separate, explicit consent.</p>

<h2>4. SMS messaging program</h2>
<p>By texting <code>${SMS_NUMBER}</code>, you initiate a conversational messaging exchange with our AI receptionist. Standard SMS terms:</p>
<ul>
  <li><strong>Message frequency</strong>: variable — depends on the back-and-forth of your conversation. Most exchanges are fewer than 10 messages per session.</li>
  <li><strong>Carrier charges</strong>: Message and data rates may apply, depending on your mobile carrier plan.</li>
  <li><strong>Opt-out</strong>: Reply <code>STOP</code> at any time to immediately end SMS communication. We will send one final confirmation and stop sending you messages.</li>
  <li><strong>Help</strong>: Reply <code>HELP</code> for assistance and contact information.</li>
  <li><strong>Supported carriers</strong>: All major United States carriers. Carriers are not liable for delayed or undelivered messages.</li>
</ul>

<h2>5. How we share information</h2>
<p>We do not sell or rent your information to third parties. We share information only as follows:</p>
<ul>
  <li><strong>With Dialog employees</strong> — the consultant or staff member you are trying to reach receives your name, company, callback number, and the substance of your message.</li>
  <li><strong>With service providers under contract</strong> — we use Twilio (telephony), Anthropic (AI processing for the receptionist), Microsoft (email infrastructure), and Railway (hosting) as data processors. They are contractually limited to processing data on our behalf and may not use it for their own purposes.</li>
  <li><strong>For legal compliance</strong> — when required by valid legal process (subpoena, court order, regulatory request) or to protect our rights, property, or safety, or the safety of others.</li>
</ul>

<h2>6. Data retention</h2>
<p>SMS conversation history is retained in active memory for up to 30 minutes of inactivity, after which it is discarded. Email records and call summaries delivered to Dialog staff are retained according to standard business correspondence practices and may be retained indefinitely as part of our consulting client records.</p>

<h2>7. Security</h2>
<p>We use industry-standard security practices to protect data in transit and at rest, including TLS encryption for all webhook traffic and authenticated API access for backend systems. No system is perfectly secure, and we cannot guarantee absolute security.</p>

<h2>8. Your rights (California residents)</h2>
<p>If you are a California resident, the California Consumer Privacy Act (CCPA) gives you the right to:</p>
<ul>
  <li>Know what personal information we have collected about you;</li>
  <li>Request deletion of your personal information, subject to operational and legal exceptions;</li>
  <li>Opt out of the sale or sharing of your personal information (Dialog does not sell personal information);</li>
  <li>Be free from discrimination for exercising these rights.</li>
</ul>
<p>To exercise these rights, contact us at the address below.</p>

<h2>9. Children's privacy</h2>
<p>Our service is not directed to children under 13, and we do not knowingly collect personal information from children under 13. If you believe we have collected such information, contact us and we will delete it.</p>

<h2>10. Changes to this policy</h2>
<p>We may update this policy from time to time. The "Effective date" at the top of this page indicates when the current version took effect. Material changes will be communicated through our website.</p>

<h2>11. Contact us</h2>
<p>For privacy questions, opt-out requests, or to exercise the rights described above:</p>
<p>
${COMPANY_NAME}<br>
${COMPANY_ADDRESS}<br>
Email: <a href="mailto:${COMPANY_EMAIL}">${COMPANY_EMAIL}</a>
</p>
`;

const TERMS_BODY = `
<h1>Terms of Service</h1>
<p class="meta">Effective date: ${DOC_DATE} · Last updated: ${DOC_DATE}</p>

<p>These Terms of Service ("Terms") govern your use of the communications services offered by <strong>${COMPANY_NAME}</strong> ("Dialog", "we", "us", or "our"), including our SMS-based AI receptionist available at <code>${SMS_NUMBER}</code>. By texting or calling our number, you accept and agree to these Terms.</p>

<h2>1. Service description</h2>
<p>Dialog operates an AI-powered receptionist service that responds to inbound calls and text messages on our main business line. The service routes communications to the appropriate Dialog consultant, takes messages on our staff's behalf, and may initiate live phone calls between callers and our consultants when both parties agree to be connected.</p>

<h2>2. SMS communications</h2>
<p>By texting our business number, you consent to receive SMS responses from our AI receptionist for the duration of your conversation. Standard terms:</p>
<ul>
  <li>Message frequency varies based on your conversation. Most exchanges are fewer than 10 messages per session.</li>
  <li>Message and data rates may apply, per your mobile carrier plan.</li>
  <li>Reply <code>STOP</code> at any time to immediately opt out. Reply <code>HELP</code> for assistance.</li>
  <li>Carriers are not liable for delayed or undelivered messages.</li>
  <li>Dialog does not use your phone number for marketing or promotional purposes without separate consent.</li>
</ul>

<h2>3. Acceptable use</h2>
<p>You agree to use Dialog's communications services only for lawful purposes. You will not:</p>
<ul>
  <li>Send threatening, harassing, defamatory, obscene, or fraudulent communications;</li>
  <li>Attempt to disrupt, overwhelm, or compromise the service;</li>
  <li>Impersonate another person or misrepresent your affiliation with any organization;</li>
  <li>Use the service for any commercial solicitation, advertising, telemarketing, or unsolicited promotional purpose;</li>
  <li>Probe, scan, or test the vulnerability of the system without prior written authorization.</li>
</ul>
<p>We may decline to respond to, transfer, or pass along any communication that we determine in our reasonable judgment to violate these Terms.</p>

<h2>4. AI-generated responses</h2>
<p>Our receptionist uses artificial intelligence to handle inbound communications. While we have configured the system to be accurate and professional, AI-generated responses may occasionally contain errors. The receptionist is intended for routing and message-taking; for substantive consulting advice or business decisions, please connect with a Dialog consultant directly.</p>

<h2>5. No professional advice</h2>
<p>Communications with our AI receptionist do not constitute professional consulting advice and do not create a consulting engagement or other professional relationship. Engagements are formed only through written agreement with Dialog.</p>

<h2>6. Disclaimers</h2>
<p>The communications services are provided "as is" and "as available" without warranties of any kind, whether express or implied, including warranties of merchantability, fitness for a particular purpose, accuracy, reliability, or non-infringement. We do not warrant that the service will be uninterrupted, error-free, or secure.</p>

<h2>7. Limitation of liability</h2>
<p>To the maximum extent permitted by law, Dialog and its members, officers, employees, and contractors will not be liable for any indirect, incidental, consequential, special, or punitive damages arising from your use of the communications services, including lost messages, missed calls, delayed responses, or any reliance on AI-generated content. Our total liability for any claim arising out of these Terms is limited to one hundred U.S. dollars (USD $100).</p>

<h2>8. Indemnification</h2>
<p>You agree to indemnify and hold harmless Dialog from any claims, damages, or expenses (including reasonable attorneys' fees) arising from your violation of these Terms or your misuse of the communications services.</p>

<h2>9. Governing law and venue</h2>
<p>These Terms are governed by the laws of the State of ${COMPANY_STATE}, without regard to conflict-of-law principles. Any dispute arising out of or relating to these Terms shall be resolved exclusively in the state or federal courts located in ${COMPANY_VENUE}, and you consent to personal jurisdiction in those courts.</p>

<h2>10. Changes to these Terms</h2>
<p>We may update these Terms from time to time. The "Effective date" at the top of this page indicates when the current version took effect. Continued use of the service after changes take effect constitutes acceptance.</p>

<h2>11. Contact us</h2>
<p>
${COMPANY_NAME}<br>
${COMPANY_ADDRESS}<br>
Email: <a href="mailto:${COMPANY_EMAIL}">${COMPANY_EMAIL}</a>
</p>
`;

const PRIVACY_HTML = htmlPage('Privacy Policy', PRIVACY_BODY);
const TERMS_HTML   = htmlPage('Terms of Service', TERMS_BODY);

function mountRoutes(app) {
  app.get('/privacy', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').type('html').send(PRIVACY_HTML);
  });
  app.get('/terms', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').type('html').send(TERMS_HTML);
  });
}

module.exports = { mountRoutes };
