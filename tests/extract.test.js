'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { extractJob, isLikelyJobPage, readJsonLdPostings } = require('../extension/content/extract.js');

function load(fixture, url) {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', fixture), 'utf8');
  return new JSDOM(html, { url }).window.document;
}

const CASES = [
  {
    fixture: 'linkedin.html',
    url: 'https://www.linkedin.com/jobs/view/4012345678/?trk=public_jobs&refId=abc',
    expected: {
      company: 'Acme Corp', role: 'Senior Backend Engineer', workMode: 'Hybrid', location: 'Bengaluru, Karnataka, India',
      yoe: '3+ yrs', salary: '', source: 'LinkedIn', url: 'https://www.linkedin.com/jobs/view/4012345678',
    },
  },
  {
    // SPA search page: the JSON-LD belongs to a previously opened job and must be ignored.
    fixture: 'linkedin-stale-jsonld.html',
    url: 'https://www.linkedin.com/jobs/search/?currentJobId=4099999999&keywords=data',
    expected: {
      company: 'Globex', role: 'Data Engineer', workMode: 'Remote', location: 'Hyderabad, Telangana, India',
      yoe: '4+ yrs', salary: '', source: 'LinkedIn', url: 'https://www.linkedin.com/jobs/view/4099999999',
    },
  },
  {
    fixture: 'naukri.html',
    url: 'https://www.naukri.com/job-listings-backend-developer-acme-technologies-pune-2-to-5-years-031025500123?src=jobsearchDesk&sid=1',
    expected: {
      company: 'Acme Technologies', role: 'Backend Developer', workMode: 'Hybrid', location: 'Pune',
      yoe: '2-5 yrs', salary: '10-14 LPA', source: 'Naukri',
      url: 'https://www.naukri.com/job-listings-backend-developer-acme-technologies-pune-2-to-5-years-031025500123?sid=1&src=jobsearchDesk',
    },
  },
  {
    fixture: 'indeed.html',
    url: 'https://in.indeed.com/viewjob?jk=a1b2c3d4e5f6&from=serp&vjs=3',
    expected: {
      company: 'Initech Software', role: 'Full Stack Developer', workMode: 'Remote', location: 'Remote in Hyderabad, Telangana',
      yoe: '2+ yrs', salary: '₹6,00,000 - ₹9,00,000 a year', source: 'Indeed', url: 'https://in.indeed.com/viewjob?jk=a1b2c3d4e5f6',
    },
  },
  {
    fixture: 'glassdoor.html',
    url: 'https://www.glassdoor.co.in/job-listing/site-reliability-engineer-globex-JV_IC2940587_KO0,25.htm?jl=1009876543210',
    expected: {
      company: 'Globex', role: 'Site Reliability Engineer', workMode: 'On-site', location: 'Chennai',
      yoe: '4-7 yrs', salary: '₹10L - ₹15L (Employer est.)', source: 'Glassdoor',
      url: 'https://www.glassdoor.co.in/job-listing/site-reliability-engineer-globex-JV_IC2940587_KO0,25.htm?jl=1009876543210',
    },
  },
  {
    fixture: 'greenhouse.html',
    url: 'https://job-boards.greenhouse.io/acmerobotics/jobs/4567890?gh_src=abc123',
    expected: {
      company: 'Acme Robotics', role: 'Robotics Software Engineer', workMode: 'Hybrid', location: 'San Francisco, CA',
      yoe: '5+ yrs', salary: '$150,000 - $190,000', source: 'Greenhouse', url: 'https://job-boards.greenhouse.io/acmerobotics/jobs/4567890',
    },
  },
  {
    fixture: 'lever.html',
    url: 'https://jobs.lever.co/acme/1b2c3d4e-5f60-7182-93a4-b5c6d7e8f901/apply?lever-source=LinkedIn',
    expected: {
      company: 'Acme', role: 'Product Designer', workMode: 'On-site', location: 'Bengaluru',
      yoe: '3-6 yrs', salary: '', source: 'Lever', url: 'https://jobs.lever.co/acme/1b2c3d4e-5f60-7182-93a4-b5c6d7e8f901',
    },
  },
  {
    fixture: 'workday.html',
    url: 'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Pune-India/Senior-QA-Engineer_R-12345?source=LinkedIn',
    expected: {
      company: 'Acme', role: 'Senior QA Engineer', workMode: 'Hybrid', location: 'Pune, India',
      yoe: '4+ yrs', salary: '', source: 'Workday',
      url: 'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Pune-India/Senior-QA-Engineer_R-12345?source=LinkedIn',
    },
  },
  {
    fixture: 'ashby.html',
    url: 'https://jobs.ashbyhq.com/globex/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b?utm_source=linkedin',
    expected: {
      company: 'Globex Corporation', role: 'Platform Engineer', workMode: 'Hybrid', location: 'Berlin',
      yoe: '2+ yrs', salary: 'EUR 70,000-90,000 / year', source: 'Ashby',
      url: 'https://jobs.ashbyhq.com/globex/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
    },
  },
  {
    fixture: 'jsonld-only.html',
    url: 'https://careers.umbrella-labs.example/positions/88',
    expected: {
      company: 'Umbrella Labs', role: 'Machine Learning Engineer', workMode: 'Remote', location: 'Remote – India',
      yoe: '3+ yrs', salary: '18-24 LPA', source: 'Company Site', url: 'https://careers.umbrella-labs.example/positions/88',
    },
  },
  {
    fixture: 'career-page.html',
    url: 'https://careers.initech.com/openings/backend-engineer/?utm_source=x#apply',
    expected: {
      company: 'Initech', role: 'Backend Engineer', workMode: 'On-site', location: 'Austin, TX',
      yoe: '3-5 yrs', salary: '$110,000 - $130,000 per year', source: 'Company Site',
      url: 'https://careers.initech.com/openings/backend-engineer',
    },
  },
];

for (const { fixture, url, expected } of CASES) {
  test(`extracts ${fixture}`, () => {
    const doc = load(fixture, url);
    const job = extractJob(doc, url);
    const { appliedDate, status, notes, ...fields } = job;
    assert.deepEqual(fields, expected);
    assert.match(appliedDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(status, 'Applied');
    assert.equal(notes, '');
    assert.equal(isLikelyJobPage(doc, url), true, 'detected as a job page');
  });
}

test('detection ignores non-job pages', () => {
  assert.equal(isLikelyJobPage(load('not-a-job.html', 'https://acme.dev/blog/scaling-postgres'), 'https://acme.dev/blog/scaling-postgres'), false);
  assert.equal(isLikelyJobPage(load('linkedin.html', 'https://www.linkedin.com/feed/'), 'https://www.linkedin.com/feed/'), false);
});

test('extraction still returns a usable job on an unrelated page', () => {
  const url = 'https://acme.dev/blog/scaling-postgres';
  const job = extractJob(load('not-a-job.html', url), url);
  assert.equal(job.company, 'Acme Engineering Blog');
  assert.equal(job.yoe, '5 yrs');
  assert.equal(job.source, 'Company Site');
  assert.equal(job.url, url);
});

test('JSON-LD reader handles arrays, @graph, mainEntity and broken JSON', () => {
  const html = `<!doctype html><html><head>
    <script type="application/ld+json">[{"@type":"Organization"},{"@type":"JobPosting","title":"A"}]</script>
    <script type="application/ld+json">{"@type":"WebPage","mainEntity":{"@type":"JobPosting","title":"B"}}</script>
    <script type="application/ld+json">{"@graph":[{"@type":"http://schema.org/JobPosting","title":"C"}]}</script>
    <script type="application/ld+json">{ this is not json</script>
  </head><body></body></html>`;
  const doc = new JSDOM(html).window.document;
  assert.deepEqual(readJsonLdPostings(doc).map((p) => p.title), ['A', 'B', 'C']);
});
