'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractYOE, workModeFrom, salaryFromText, canonicalUrl, sourceFromHost,
} = require('../extension/content/extract.js');

test('YOE: ranges, plus forms, minimums and plain forms', () => {
  const cases = [
    ['We need 2-5 years of experience in Go.', '2-5 yrs'],
    ['Experience: 3 to 5 yrs', '3-5 yrs'],
    ['Experience: 2 – 4 years', '2-4 yrs'],
    ['5+ years of professional experience', '5+ yrs'],
    ['At least 3 years of experience with React', '3+ yrs'],
    ['a minimum of 4 yrs hands-on experience', '4+ yrs'],
    ['Min. 2 years exp in sales', '2+ yrs'],
    ['3 years of experience building APIs', '3 yrs'],
    ['1 year of experience is a plus', '1 yr'],
    ['1.5 years experience', '1.5 yrs'],
  ];
  for (const [text, expected] of cases) assert.equal(extractYOE(text), expected, text);
});

test('YOE: number words', () => {
  assert.equal(extractYOE('Three (3) years of relevant experience'), '3 yrs');
  assert.equal(extractYOE('Three to five years of experience'), '3-5 yrs');
  assert.equal(extractYOE('ten+ years of experience leading teams'), '10+ yrs');
  assert.equal(extractYOE('at least two years of experience'), '2+ yrs');
  assert.equal(extractYOE('five years of experience in finance'), '5 yrs');
  assert.equal(extractYOE('two to four years of experience'), '2-4 yrs');
});

test('YOE: requires "experience" within ~90 characters', () => {
  assert.equal(extractYOE('Our company was founded 12 years back and serves clients in 40 countries.'), 'N/A');
  const far = `5 years ${'x'.repeat(120)} experience`;
  assert.equal(extractYOE(far), 'N/A');
  assert.equal(extractYOE('2-5 years', { requireContext: false }), '2-5 yrs');
  assert.equal(extractYOE('3-5 Yrs', { requireContext: false }), '3-5 yrs', 'Naukri header chip');
  assert.equal(extractYOE('0-2 Yrs', { requireContext: false }), '0-2 yrs');
});

test('YOE: rejects values over 30, ages and "ago"', () => {
  assert.equal(extractYOE('Must be 18 years old. No prior experience needed.'), 'N/A');
  assert.equal(extractYOE('Founded 25 years ago, we value experience.'), 'N/A');
  assert.equal(extractYOE('Founded 10 years ago, we now need 2 years of experience in Go.'), '2 yrs');
  assert.equal(extractYOE('Founded ten years ago. Experience with Kubernetes is a plus.'), 'N/A');
  assert.equal(extractYOE('40 years of combined team experience'), 'N/A');
  assert.equal(extractYOE('5-3 years experience'), 'N/A');
});

test('YOE: earliest valid match wins', () => {
  assert.equal(extractYOE('Required: 3+ years experience in Java. Preferred: 5 years experience in Go.'), '3+ yrs');
  assert.equal(extractYOE('We are 50 years ago old... Requirements: 4-6 years experience'), '4-6 yrs');
});

test('YOE: fresher fallback', () => {
  assert.equal(extractYOE('This is an entry-level role for new grads.'), 'Fresher');
  assert.equal(extractYOE('Freshers welcome!'), 'Fresher');
  assert.equal(extractYOE('Great team, great pay.'), 'N/A');
});

test('work mode: explicit beats loose beats strict, Hybrid > Remote > On-site', () => {
  assert.equal(workModeFrom({ explicit: 'TELECOMMUTE', location: 'Pune' }), 'Remote');
  assert.equal(workModeFrom({ explicit: 'On-site', description: 'fully remote' }), 'On-site');
  assert.equal(workModeFrom({ location: 'Remote, Hybrid' }), 'Hybrid');
  assert.equal(workModeFrom({ location: 'Bengaluru (Remote)' }), 'Remote');
  assert.equal(workModeFrom({ location: 'Remote (India)' }), 'Remote');
  assert.equal(workModeFrom({ location: 'Pune; Mumbai', description: 'Hybrid: 3 days a week in the office.' }), 'Hybrid');
  assert.equal(workModeFrom('Onsite - Mumbai'), 'On-site');
  assert.equal(workModeFrom({ location: 'Pune', description: 'This is a fully remote position.' }), 'Remote');
  assert.equal(workModeFrom({ description: 'Work from office 5 days a week.' }), 'On-site');
});

test('work mode: strict description phrases only', () => {
  assert.equal(workModeFrom({ description: 'You will collaborate with remote teams across time zones.' }), 'N/A');
  assert.equal(workModeFrom({ description: 'Experience managing remote teams is a plus.', location: 'Chennai' }), 'N/A');
  assert.equal(workModeFrom({ description: 'Experience with hybrid cloud deployments.' }), 'N/A');
  assert.equal(workModeFrom({ description: 'We follow a hybrid work model.' }), 'Hybrid');
  assert.equal(workModeFrom({}), 'N/A');
});

test('salary: Indian and international formats near salary keywords', () => {
  assert.equal(salaryFromText('CTC: 12-18 LPA plus benefits'), '12-18 LPA');
  assert.equal(salaryFromText('Salary: ₹ 8,00,000 - 12,00,000 per annum'), '₹ 8,00,000 - 12,00,000 per annum');
  assert.equal(salaryFromText('Compensation range is $120,000 - $150,000 a year.'), '$120,000 - $150,000 a year');
  assert.equal(salaryFromText('Stipend of INR 25k/month'), 'INR 25k/month');
  assert.equal(salaryFromText('Package up to 15 LPA'), '15 LPA');
});

test('salary: ignores amounts far from salary keywords', () => {
  assert.equal(salaryFromText('We raised $5 million in our Series A last year.'), '');
  assert.equal(salaryFromText('Manage a $2M marketing budget.'), '');
  assert.equal(salaryFromText(''), '');
  assert.equal(salaryFromText('Salary: Not disclosed'), '');
});

test('canonical URL: LinkedIn', () => {
  const expected = 'https://www.linkedin.com/jobs/view/4012345678';
  assert.equal(canonicalUrl('https://www.linkedin.com/jobs/view/4012345678/?refId=abc&trk=xyz'), expected);
  assert.equal(canonicalUrl('https://in.linkedin.com/jobs/view/senior-engineer-at-acme-4012345678'), expected);
  assert.equal(canonicalUrl('https://www.linkedin.com/jobs/search/?currentJobId=4012345678&keywords=go'), expected);
  assert.equal(canonicalUrl('https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4012345678'), expected);
});

test('canonical URL: Indeed keeps the country host', () => {
  assert.equal(canonicalUrl('https://in.indeed.com/viewjob?jk=abc123&from=serp&vjs=3'), 'https://in.indeed.com/viewjob?jk=abc123');
  assert.equal(canonicalUrl('https://www.indeed.com/jobs?q=go&vjk=def456'), 'https://www.indeed.com/viewjob?jk=def456');
});

test('canonical URL: strips tracking, hash, /apply and trailing slash', () => {
  assert.equal(
    canonicalUrl('https://Jobs.Lever.co/acme/1b2c3d4e-0000-0000-0000-000000000000/apply?lever-source=LinkedIn&utm_source=x#top'),
    'https://jobs.lever.co/acme/1b2c3d4e-0000-0000-0000-000000000000',
  );
  assert.equal(
    canonicalUrl('https://acme.com/careers/?gh_jid=123&gh_src=abc&fbclid=1&gclid=2&ref=hn'),
    'https://acme.com/careers?gh_jid=123',
  );
  assert.equal(canonicalUrl('https://acme.com/jobs/42?b=2&a=1'), 'https://acme.com/jobs/42?a=1&b=2');
  assert.equal(canonicalUrl('https://acme.com:443/'), 'https://acme.com');
  assert.equal(canonicalUrl('not a url'), 'not a url');
  assert.equal(canonicalUrl('https://www.acmerobotics.com/careers/?gh_jid=4567890&gh_src=x'), 'https://www.acmerobotics.com/careers?gh_jid=4567890');
});

test('canonical URL: path-identified job sites drop search and session parameters', () => {
  assert.equal(
    canonicalUrl('https://acme.wd5.myworkdayjobs.com/en-US/External/job/Pune/QA_R-1?source=LinkedIn'),
    'https://acme.wd5.myworkdayjobs.com/External/job/Pune/QA_R-1',
  );
  assert.equal(
    canonicalUrl('https://wd3.myworkdaysite.com/fr-FR/recruiting/acme/External/job/Paris/Dev_R-2'),
    'https://wd3.myworkdaysite.com/recruiting/acme/External/job/Paris/Dev_R-2',
  );
  assert.equal(
    canonicalUrl('https://www.naukri.com/job-listings-dev-acme-pune-2-to-5-years-031025500123?src=jobsearchDesk&sid=99&xp=1'),
    'https://www.naukri.com/job-listings-dev-acme-pune-2-to-5-years-031025500123',
  );
  assert.equal(canonicalUrl('https://job-boards.greenhouse.io/acme/jobs/123?gh_src=x&t=y'), 'https://job-boards.greenhouse.io/acme/jobs/123');
  assert.equal(
    canonicalUrl('https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123'),
    'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123',
  );
});

test('source from hostname', () => {
  const cases = {
    'www.linkedin.com': 'LinkedIn', 'www.naukri.com': 'Naukri', 'in.indeed.com': 'Indeed', 'indeed.co.uk': 'Indeed',
    'www.glassdoor.co.in': 'Glassdoor', 'acme.wd5.myworkdayjobs.com': 'Workday', 'wd3.myworkdaysite.com': 'Workday',
    'job-boards.greenhouse.io': 'Greenhouse', 'jobs.lever.co': 'Lever', 'jobs.ashbyhq.com': 'Ashby',
    'jobs.smartrecruiters.com': 'SmartRecruiters', 'careers-acme.icims.com': 'iCIMS', 'wellfound.com': 'Wellfound',
    'angel.co': 'Wellfound', 'www.instahyre.com': 'Instahyre', 'www.foundit.in': 'Foundit', 'cutshort.io': 'Cutshort',
    'www.hirist.tech': 'Hirist', 'internshala.com': 'Internshala', 'acme.taleo.net': 'Taleo',
    'career5.successfactors.eu': 'SuccessFactors', 'acme.fa.us2.oraclecloud.com': 'Oracle Cloud',
    'acme.bamboohr.com': 'BambooHR', 'apply.workable.com': 'Workable', 'acme.recruitee.com': 'Recruitee',
    'jobs.jobvite.com': 'Jobvite', 'acme.teamtailor.com': 'Teamtailor', 'acme.zohorecruit.in': 'Zoho Recruit',
    'careers.acme.com': 'Company Site', 'notlinkedin.com': 'Company Site',
  };
  for (const [host, expected] of Object.entries(cases)) assert.equal(sourceFromHost(host), expected, host);
});
