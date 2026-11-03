// k6: concurrent acceptance. For every request, all of its bids are accepted at the same moment;
// exactly one may win (201) and the rest must be refused (409).
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

const fx = JSON.parse(open('./data/fixture.json'));
const attempts = [];
for (const t of fx.acceptTargets) for (const bidId of t.bidIds) attempts.push({ token: t.studentToken, bidId });
const won = new Counter('accept_won');
const refused = new Counter('accept_conflict_409');
const unexpected = new Counter('accept_unexpected');

export const options = {
  scenarios: {
    accept: { executor: 'shared-iterations', vus: attempts.length, iterations: attempts.length, maxDuration: '1m' },
  },
  thresholds: {
    accept_unexpected: ['count==0'],
    accept_won: [`count==${fx.acceptTargets.length}`],
    'http_req_duration{name:accept_bid}': ['p(95)<1000'],
  },
};

export default function () {
  const a = attempts[exec.scenario.iterationInTest];
  const res = http.post(`${fx.baseUrl}/student/bids/${a.bidId}/accept`, null, {
    headers: { Authorization: `Bearer ${a.token}` },
    tags: { name: 'accept_bid' },
    responseCallback: http.expectedStatuses(201, 409),
  });
  if (res.status === 201) won.add(1);
  else if (res.status === 409) refused.add(1);
  else unexpected.add(1);
  check(res, { '201 or 409': (r) => r.status === 201 || r.status === 409 });
}
