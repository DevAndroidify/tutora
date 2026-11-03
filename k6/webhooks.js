// k6: webhook ingestion. Signed fake-gateway webhooks, each sent twice (the second must be a duplicate).
// Razorpay requires a 2xx within 5 seconds, so ingestion only verifies, saves and enqueues.
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

const fx = JSON.parse(open('./data/fixture.json'));
const sends = [...fx.webhooks, ...fx.webhooks];
const duplicates = new Counter('webhook_duplicates_detected');

export const options = {
  scenarios: {
    ingest: { executor: 'shared-iterations', vus: 25, iterations: sends.length, maxDuration: '2m' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:webhook}': ['p(95)<250', 'max<5000'],
  },
};

export default function () {
  const i = exec.scenario.iterationInTest;
  const w = sends[i];
  const res = http.post(`${fx.baseUrl}/webhooks/fake`, w.body, {
    headers: { 'Content-Type': 'application/json', 'x-fake-signature': w.signature, 'x-fake-event-id': w.eventId },
    tags: { name: 'webhook' },
  });
  check(res, { '200': (r) => r.status === 200 });
  if (res.status === 200 && JSON.parse(res.body).duplicate) duplicates.add(1);
}
