import { BiddingService } from '../../src/modules/bidding/bidding.service';
import { approvedTutor, openRequest } from '../fixtures/marketplace';
import {
  bearer,
  createTestApp,
  registerMember,
  resetState,
  seedCatalog,
  skillId,
  type TestApp,
} from '../fixtures/test-app';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

describe('Part 4: learning requests and uploads', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await resetState(t);
    await seedCatalog(t);
  });

  afterAll(async () => {
    await t.close();
  });

  async function draft(
    student: { accessToken: string },
    overrides: Record<string, unknown> = {},
    status = 201,
  ) {
    return t.http
      .post('/student/requests')
      .set(bearer(student))
      .send({
        skillId: await skillId(t, 'video-editing'),
        level: 'INTERMEDIATE',
        title: 'Color grading for YouTube vlogs',
        description: 'My footage looks flat. Reach me at 9876543210 to discuss.',
        budgetHintPaise: 50000,
        ...overrides,
      })
      .expect(status);
  }

  it('creates a draft with contact details hidden, then publishes it with an expiry', async () => {
    const student = await registerMember(t, 'student');
    const created = await draft(student);
    expect(created.body).toMatchObject({
      status: 'DRAFT',
      skill: { slug: 'video-editing' },
      level: 'INTERMEDIATE',
      budgetHintPaise: 50000,
      currency: 'INR',
      expiresAt: null,
    });
    expect(created.body.description).toContain('[hidden]');
    expect(created.body.description).not.toContain('9876543210');

    const published = await t.http
      .post(`/student/requests/${created.body.id}/publish`)
      .set(bearer(student))
      .expect(200);
    expect(published.body.status).toBe('OPEN');
    const ttlMs =
      new Date(published.body.expiresAt).getTime() - new Date(published.body.publishedAt).getTime();
    expect(ttlMs).toBe(t.config.env.REQUEST_TTL_HOURS * 3_600_000);
  });

  it('returns 409 for invalid transitions', async () => {
    const student = await registerMember(t, 'student');
    const id = (await draft(student)).body.id;
    await t.http.post(`/student/requests/${id}/publish`).set(bearer(student)).expect(200);

    const twice = await t.http
      .post(`/student/requests/${id}/publish`)
      .set(bearer(student))
      .expect(409);
    expect(twice.body.error).toMatchObject({
      code: 'INVALID_REQUEST_STATE',
      details: { status: 'OPEN' },
    });
    await t.http
      .patch(`/student/requests/${id}`)
      .set(bearer(student))
      .send({ title: 'New title here' })
      .expect(409);

    await t.http.post(`/student/requests/${id}/cancel`).set(bearer(student)).expect(200);
    await t.http.post(`/student/requests/${id}/cancel`).set(bearer(student)).expect(409);
    await t.http.post(`/student/requests/${id}/publish`).set(bearer(student)).expect(409);
  });

  it("students can't read or change another student's request", async () => {
    const owner = await registerMember(t, 'student');
    const other = await registerMember(t, 'student');
    const id = (await draft(owner)).body.id;
    const auth = bearer(other);
    for (const send of [
      () => t.http.get(`/student/requests/${id}`).set(auth),
      () => t.http.patch(`/student/requests/${id}`).set(auth).send({ title: 'Hijacked title' }),
      () => t.http.post(`/student/requests/${id}/publish`).set(auth),
      () => t.http.post(`/student/requests/${id}/cancel`).set(auth),
      () => t.http.get(`/student/requests/${id}/bids`).set(auth),
    ]) {
      const res = await send().expect(403);
      expect(res.body.error.code).toBe('NOT_OWNER');
    }
    const mine = await t.http.get('/student/requests').set(bearer(other)).expect(200);
    expect(mine.body.total).toBe(0);
  });

  it('validates the skill and topic', async () => {
    const student = await registerMember(t, 'student');
    const unknownTopic = await draft(
      student,
      { topicId: '00000000-0000-4000-8000-000000000000' },
      400,
    );
    expect(unknownTopic.body.error.code).toBe('UNKNOWN_TOPIC');
    const detail = await t.http.get('/public/skills/video-editing').expect(200);
    await draft(student, { topicId: detail.body.topics[0].id });
  });

  it('expiry sweep closes open requests after the window, and running it twice is safe', async () => {
    const student = await registerMember(t, 'student');
    const id = await openRequest(t, student);
    const bidding = t.app.get(BiddingService);
    expect(await bidding.expireDueRequests()).toBe(0);
    t.clock.advanceHours(t.config.env.REQUEST_TTL_HOURS + 1);
    expect(await bidding.expireDueRequests()).toBe(1);
    expect(await bidding.expireDueRequests()).toBe(0);
    const fresh = await t.http
      .post('/student/auth/login')
      .send({ email: student.email, password: student.password })
      .expect(200);
    expect(
      (await t.http.get(`/student/requests/${id}`).set(bearer(fresh.body)).expect(200)).body.status,
    ).toBe('EXPIRED');
  });

  it('uploads a file to MinIO with a presigned URL and attaches it', async () => {
    const student = await registerMember(t, 'student');
    const id = (await draft(student)).body.id;

    const presign = await t.http
      .post('/student/uploads/presign')
      .set(bearer(student))
      .send({ contentType: 'image/png', sizeBytes: PNG.length })
      .expect(201);
    expect(presign.body.objectKey).toMatch(
      new RegExp(`^uploads/request_attachment/${student.userId}/`),
    );

    const put = await fetch(presign.body.uploadUrl, {
      method: 'PUT',
      headers: presign.body.headers,
      body: PNG,
    });
    expect(put.status).toBe(200);

    const attached = await t.http
      .post(`/student/requests/${id}/attachments`)
      .set(bearer(student))
      .send({ objectKey: presign.body.objectKey, fileName: 'chart.png' })
      .expect(201);
    expect(attached.body.attachments).toEqual([
      expect.objectContaining({
        fileName: 'chart.png',
        contentType: 'image/png',
        sizeBytes: PNG.length,
      }),
    ]);
    const download = await fetch(attached.body.attachments[0].url);
    expect(Buffer.from(await download.arrayBuffer()).equals(PNG)).toBe(true);

    // Same key twice, someone else's key, and a file that was never uploaded.
    await t.http
      .post(`/student/requests/${id}/attachments`)
      .set(bearer(student))
      .send({ objectKey: presign.body.objectKey, fileName: 'chart.png' })
      .expect(409);
    const other = await registerMember(t, 'student');
    const otherDraft = (await draft(other)).body.id;
    await t.http
      .post(`/student/requests/${otherDraft}/attachments`)
      .set(bearer(other))
      .send({ objectKey: presign.body.objectKey, fileName: 'stolen.png' })
      .expect(403);
    const missing = await t.http
      .post(`/student/requests/${id}/attachments`)
      .set(bearer(student))
      .send({
        objectKey: `uploads/request_attachment/${student.userId}/nope.png`,
        fileName: 'x.png',
      })
      .expect(400);
    expect(missing.body.error.code).toBe('UPLOAD_NOT_FOUND');
  });

  it('rejects disallowed file types and sizes before issuing a URL', async () => {
    const student = await registerMember(t, 'student');
    const exe = await t.http
      .post('/student/uploads/presign')
      .set(bearer(student))
      .send({ contentType: 'application/x-msdownload', sizeBytes: 100 })
      .expect(400);
    expect(exe.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    const big = await t.http
      .post('/student/uploads/presign')
      .set(bearer(student))
      .send({ contentType: 'application/pdf', sizeBytes: t.config.env.UPLOAD_MAX_BYTES + 1 })
      .expect(400);
    expect(big.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('only approved tutors see open requests in their skills, with the learner shown by first name', async () => {
    const student = await registerMember(t, 'student', { fullName: 'Priya Raman Iyer' });
    await openRequest(t, student, 'technical-analysis');
    await openRequest(t, student, 'video-editing', {
      title: 'Editing help please',
      description: 'Cutting long interviews.',
    });

    const tutor = await approvedTutor(t, ['technical-analysis']);
    const list = await t.http.get('/tutor/requests').set(bearer(tutor)).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({
      skill: { slug: 'technical-analysis' },
      studentDisplayName: 'Priya R.',
      bidCount: 0,
    });
    expect(JSON.stringify(list.body)).not.toContain(student.email);

    const unverified = await registerMember(t, 'tutor');
    const res = await t.http.get('/tutor/requests').set(bearer(unverified)).expect(403);
    expect(res.body.error.code).toBe('TUTOR_NOT_VERIFIED');
  });
});
