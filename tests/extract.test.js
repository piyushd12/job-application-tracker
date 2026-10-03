'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { extractJob, isLikelyJobPage, readJsonLdPostings } = require('../extension/content/extract.js');

function load(fixture, url) {
  return load.fromHtml(fs.readFileSync(path.join(__dirname, 'fixtures', fixture), 'utf8'), url);
}
load.fromHtml = (html, url) => new JSDOM(html, { url }).window.document;

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
      url: 'https://www.naukri.com/job-listings-backend-developer-acme-technologies-pune-2-to-5-years-031025500123',
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
      url: 'https://acme.wd5.myworkdayjobs.com/External/job/Pune-India/Senior-QA-Engineer_R-12345',
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
  // ----- Edge cases -----
  {
    // "3-5 Yrs" chip, salary "Not disclosed", several location links, "remote teams" and "Founded 10 years ago" in the text.
    fixture: 'naukri-edge.html',
    url: 'https://www.naukri.com/job-listings-data-engineer-acme-technologies-pune-mumbai-bengaluru-3-to-5-years-031025500999?src=jobsearchDesk&sid=17000',
    expected: {
      company: 'Acme Technologies', role: 'Data Engineer', workMode: 'N/A', location: 'Pune; Mumbai; Bengaluru',
      yoe: '3-5 yrs', salary: '', source: 'Naukri',
      url: 'https://www.naukri.com/job-listings-data-engineer-acme-technologies-pune-mumbai-bengaluru-3-to-5-years-031025500999',
    },
  },
  {
    // "Remote (India)" location, years written as words after a "Founded 10 years ago" distractor.
    fixture: 'lever-remote.html',
    url: 'https://jobs.lever.co/acme/2c3d4e5f-6071-8293-a4b5-c6d7e8f90a1b?lever-origin=applied',
    expected: {
      company: 'Acme', role: 'Support Engineer', workMode: 'Remote', location: 'Remote (India)',
      yoe: '3-5 yrs', salary: '', source: 'Lever', url: 'https://jobs.lever.co/acme/2c3d4e5f-6071-8293-a4b5-c6d7e8f90a1b',
    },
  },
  {
    // Greenhouse embedded on a company domain: the job is in a cross-origin iframe, gh_jid identifies it.
    fixture: 'greenhouse-embed.html',
    url: 'https://www.acmerobotics.com/careers/?gh_jid=4567890&gh_src=abc123',
    expected: {
      company: 'Acme Robotics', role: '', workMode: 'N/A', location: '',
      yoe: 'N/A', salary: '', source: 'Company Site', url: 'https://www.acmerobotics.com/careers?gh_jid=4567890',
    },
  },
  {
    // No h1: role and company come from the title; Hybrid is only mentioned in the description.
    fixture: 'no-h1.html',
    url: 'https://jobs.example-corp.com/positions/12345',
    expected: {
      company: 'Example Corp', role: 'Senior Product Designer', workMode: 'Hybrid', location: 'Austin, TX',
      yoe: '5+ yrs', salary: '', source: 'Company Site', url: 'https://jobs.example-corp.com/positions/12345',
    },
  },
  {
    // Workday locale path (/de-DE/), several locations, no remoteType field.
    fixture: 'workday-multi.html',
    url: 'https://acme.wd5.myworkdayjobs.com/de-DE/External/job/Multiple-Locations/Data-Analyst_R-555?source=Indeed',
    expected: {
      company: 'Acme', role: 'Data Analyst', workMode: 'Remote', location: 'Pune, India; Bengaluru, India',
      yoe: '2-4 yrs', salary: '', source: 'Workday',
      url: 'https://acme.wd5.myworkdayjobs.com/External/job/Multiple-Locations/Data-Analyst_R-555',
    },
  },
  {
    // JSON-LD inside an HTML comment, with a raw newline in a string, trailing commas and two locations,
    // next to a block that is broken beyond repair.
    fixture: 'jsonld-malformed.html',
    url: 'https://stark.example/careers/qa-lead',
    expected: {
      company: 'Stark Industries', role: 'QA Lead', workMode: 'N/A',
      location: 'Pune, Maharashtra, IN; Hyderabad, Telangana, IN',
      yoe: '6+ yrs', salary: '12-18 LPA', source: 'Company Site', url: 'https://stark.example/careers/qa-lead',
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
  assert.equal(isLikelyJobPage(load('linkedin.html', 'https://www.linkedin.com/jobs/'), 'https://www.linkedin.com/jobs/'), false);
});

test('detection covers LinkedIn search and collection pages with currentJobId', () => {
  for (const url of [
    'https://www.linkedin.com/jobs/search/?currentJobId=4099999999&keywords=data',
    'https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4099999999',
  ]) {
    const doc = load('linkedin-stale-jsonld.html', url);
    assert.equal(isLikelyJobPage(doc, url), true, url);
    assert.equal(extractJob(doc, url).url, 'https://www.linkedin.com/jobs/view/4099999999');
  }
});

test('very long descriptions are capped and stay fast', () => {
  const filler = '<p>Our platform team ships every day and values ownership. </p>'.repeat(20000); // ~1.2 MB
  const html = (intro) => `<!doctype html><html><head><title>Backend Engineer | Acme</title></head><body>
    <h1>Backend Engineer</h1><div class="job-description"><p>${intro}</p>${filler}<p>Salary: 30-40 LPA</p></div></body></html>`;
  const url = 'https://careers.acme.com/jobs/1';

  const started = Date.now();
  const doc = load.fromHtml(html('Requirements: 4+ years of experience.'), url);
  assert.equal(isLikelyJobPage(doc, url), true);
  const job = extractJob(doc, url);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.equal(job.yoe, '4+ yrs');
  assert.equal(job.salary, '', 'text past the 50,000-character cap is not parsed');
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
    <script type="application/ld+json">//<![CDATA[
      {"@type":"JobPosting","title":"D",}
    //]]></script>
  </head><body></body></html>`;
  const doc = new JSDOM(html).window.document;
  assert.deepEqual(readJsonLdPostings(doc).map((p) => p.title), ['A', 'B', 'C', 'D']);
});
