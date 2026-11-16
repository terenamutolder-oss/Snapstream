const { initializeApp } = require('firebase-admin/app')
const { getAuth } = require('firebase-admin/auth')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const { onDocumentCreated } = require('firebase-functions/v2/firestore')
const { defineString } = require('firebase-functions/params')
const { setGlobalOptions } = require('firebase-functions/v2')
const nodemailer = require('nodemailer')

setGlobalOptions({ region: 'us-central1', maxInstances: 10 })
initializeApp()

const FEEDBACK_EMAIL = 'terenamutolder@gmail.com'
const feedbackMailUrl = defineString('FEEDBACK_MAIL_URL', { default: '' })
const gmailAppPassword = defineString('GMAIL_APP_PASSWORD', { default: '' })

/**
 * When someone submits feedback:
 * 1) Push an in-app notification to terenamutolder@gmail.com
 * 2) Email via Apps Script webhook (optional) OR Gmail SMTP (GMAIL_APP_PASSWORD)
 * FormSubmit is intentionally not used — Cloudflare blocks it from Functions/browsers.
 */
exports.notifyFeedback = onDocumentCreated(
  {
    document: 'feedback/{feedbackId}',
    retry: true,
  },
  async (event) => {
    const snap = event.data
    if (!snap) return

    const data = snap.data() || {}
    if (data.notifyStatus === 'done' || data.notifyStatus === 'skipped') return

    const name = String(data.name || 'SnapStream user')
    const email = String(data.email || '')
    const subject = String(data.subject || 'SnapStream feedback')
    const message = String(data.message || '')
    const feedbackId = event.params.feedbackId
    const createdAt = new Date().toISOString()

    const results = { notification: null, email: null }

    // In-app notification for the inbox owner
    try {
      const owner = await getAuth().getUserByEmail(FEEDBACK_EMAIL)
      const notifId = `feedback-${feedbackId}`
      await getFirestore()
        .collection('userNotifications')
        .doc(owner.uid)
        .collection('items')
        .doc(notifId)
        .set(
          {
            id: notifId,
            type: 'system',
            title: `Feedback: ${subject}`,
            body: `${name} <${email}> — ${message.slice(0, 180)}${message.length > 180 ? '…' : ''}`,
            createdAt,
            read: false,
            href: '/feedback',
            avatar: '',
          },
          { merge: true },
        )
      results.notification = 'ok'
    } catch (err) {
      results.notification = `skip:${err && err.code ? err.code : String(err)}`
    }

    // Email notify
    const webhook = (feedbackMailUrl.value() || '').trim()
    const appPassword = (gmailAppPassword.value() || '').trim()
    try {
      if (webhook) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 12000)
        try {
          const res = await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ name, email, subject, message }),
            redirect: 'follow',
            signal: controller.signal,
          })
          results.email = res.ok ? 'webhook-ok' : `webhook-${res.status}`
        } finally {
          clearTimeout(timer)
        }
      } else if (appPassword) {
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: FEEDBACK_EMAIL,
            pass: appPassword,
          },
        })
        await transporter.sendMail({
          from: `SnapStream Feedback <${FEEDBACK_EMAIL}>`,
          to: FEEDBACK_EMAIL,
          replyTo: email || FEEDBACK_EMAIL,
          subject: `[SnapStream] ${subject}`,
          text: [
            `New SnapStream feedback`,
            ``,
            `From: ${name}`,
            `Email: ${email || '(none)'}`,
            `Subject: ${subject}`,
            `Feedback ID: ${feedbackId}`,
            ``,
            message,
          ].join('\n'),
        })
        results.email = 'gmail-ok'
      } else {
        results.email = 'skipped:no-mail-config'
      }
    } catch (err) {
      results.email = `error:${String(err && err.message ? err.message : err)}`
    }

    await snap.ref.set(
      {
        notifyStatus: 'done',
        notifyResults: results,
        notifiedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
  },
)
