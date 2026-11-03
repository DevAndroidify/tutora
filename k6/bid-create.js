// k6: sealed bid creation. Each (tutor, request) pair bids exactly once.
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

const fx = JSON.parse(open('./data/fixture.json'));
const pairs = [];
for (const t of fx.tutors) for (const r of fx.createRequests) pairs.push({ token: t, requestId: r });
const created = new Counter('bids_created');

export const options = {
  scenarios: {
    create: { executor: 'shared-iterations', vus: 20, iterations: pairs.length, maxDuration: '2m' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:create_bid}': ['p(95)<500'],
  },
};

export default function () {
  const p = pairs[exec.scenario.iterationInTest];
  const res = http.post(
    `${fx.baseUrl}/tutor/requests/${p.requestId}/bids`,
    JSON.stringify({ seatPricePaise: 45000, proposedStartAt: fx.startAt, durationMinutes: 60, approachText: 'Load-test bid.' }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.token}` }, tags: { name: 'create_bid' } },
  );
  if (check(res, { 'bid created (201)': (r) => r.status === 201 })) created.add(1);
}
