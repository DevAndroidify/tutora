Webhook bodies in the format documented by Razorpay (test mode). All ids, VPAs and contacts are
made-up test values (Razorpay test VPA `success@razorpay`). No real payment data.
Placeholders `{{ORDER_ID}}`, `{{PAYMENT_ID}}` and `{{AMOUNT}}` are filled in by the tests, which then
sign the body with the test webhook secret.
