// Startup Radar resources (DOM-free, plan §3.2 item 20): 16 curated links in 4 groups for resources.html and
// scripts/check-links.mjs. Links only: nothing here is fetched, counted or ranked. Every note is one plain sentence
// saying what the page is and who publishes it (test/resources.test.js guards length and wording).

export const RESOURCE_GROUPS = [
  {
    title: 'Idea sources',
    links: [
      { name: 'YC Request for Startups', url: 'https://www.ycombinator.com/rfs', note: 'Y Combinator\u2019s list of problem areas it would like to fund, updated by its partners.' },
      { name: 'Paul Graham \u2014 How to Get Startup Ideas', url: 'https://paulgraham.com/startupideas.html', note: 'Paul Graham\u2019s 2012 essay on noticing problems you have yourself instead of inventing ideas.' },
      { name: 'a16z Big Ideas', url: 'https://a16z.com/big-ideas-in-tech-2025/', note: 'Andreessen Horowitz partners each name one technology theme they expect for the coming year.' },
      { name: 'Sequoia Arc', url: 'https://www.sequoiacap.com/arc/', note: 'Sequoia Capital\u2019s company-building programme for founders at the seed and early stage.' },
    ],
  },
  {
    title: 'Reports',
    links: [
      { name: 'Bessemer State of the Cloud', url: 'https://www.bvp.com/atlas/state-of-the-cloud-2024', note: 'Bessemer Venture Partners\u2019 yearly report on cloud and software companies and their metrics.' },
      { name: 'Blume Indus Valley Report', url: 'https://blume.vc/reports/indus-valley-annual-report-2025', note: 'Blume Ventures\u2019 annual report on the Indian economy, consumers and startup ecosystem.' },
      { name: 'Inc42 reports', url: 'https://inc42.com/reports/', note: 'Inc42\u2019s paid and free research reports on Indian startups and funding.' },
      { name: 'Peak XV', url: 'https://www.peakxv.com/', note: 'Peak XV Partners (formerly Sequoia India and Southeast Asia) publishes its portfolio and perspectives here.' },
    ],
  },
  {
    title: 'Communities',
    links: [
      { name: 'Indie Hackers', url: 'https://www.indiehackers.com/', note: 'Forum and interviews of founders of self-funded products, run by Stripe.' },
      { name: 'Hacker News', url: 'https://news.ycombinator.com/', note: 'Y Combinator\u2019s link-sharing board; Show HN and Ask HN threads are also aggregated in this site\u2019s feed.' },
      { name: 'Product Hunt', url: 'https://www.producthunt.com/', note: 'Daily list of product launches voted on by its members; the launches feed here comes from it.' },
      { name: 'YC Startup School', url: 'https://www.startupschool.org/', note: 'Y Combinator\u2019s free online course and co-founder matching for people starting a company.' },
    ],
  },
  {
    title: 'Learning',
    links: [
      { name: 'YC Library', url: 'https://www.ycombinator.com/library', note: 'Y Combinator\u2019s collection of its essays, talks and videos on starting and running a company.' },
      { name: 'Lenny\u2019s Newsletter', url: 'https://www.lennysnewsletter.com/', note: 'Lenny Rachitsky\u2019s newsletter on product, growth and working at tech companies; some posts are paid.' },
      { name: 'First Round Review', url: 'https://review.firstround.com/', note: 'First Round Capital\u2019s magazine of long interviews with operators about company building.' },
      { name: 'Startup Playbook', url: 'https://playbook.samaltman.com/', note: 'Sam Altman\u2019s short 2015 guide for Y Combinator founders on the basics of starting a company.' },
    ],
  },
];
