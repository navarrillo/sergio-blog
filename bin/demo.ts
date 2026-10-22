import { migrate, db, setSetting } from '../src/lib/db';
import { savePost } from '../src/lib/content';
if (process.env.DEMO_MODE !== 'true' || process.env.NODE_ENV === 'production')
  throw new Error('Demo seeding requires DEMO_MODE=true outside production.');
await migrate();
if (db().prepare('SELECT id FROM posts LIMIT 1').get())
  throw new Error('Demo seeding requires an empty content database.');
setSetting('demo', 'true');
setSetting(
  'bio',
  '[Demo biography] Exploring the space between technology, thoughtful tools, and a life well lived. These are sample entries for reviewing the design.',
);
const demos = [
  {
    title: 'Building a quieter corner of the internet',
    slug: 'a-quieter-corner',
    summary:
      '[Demo] On owning your words, keeping things simple, and making a small place to think out loud.',
    tags: ['building', 'internet'],
    featured: true,
  },
  {
    title: 'Small tools, lasting usefulness',
    slug: 'small-tools',
    summary:
      '[Demo] A few thoughts on software that does one thing well, and knows when to get out of the way.',
    tags: ['software', 'craft'],
    featured: true,
  },
  {
    title: 'The value of starting before you’re ready',
    slug: 'starting-before-ready',
    summary: '[Demo] Sometimes the first version only needs to exist.',
    tags: ['learning'],
    type: 'note',
  },
  {
    title: 'A notebook is an invitation to notice',
    slug: 'notebook',
    summary:
      '[Demo] Collecting the small details that would otherwise slip away.',
    tags: ['notes'],
    type: 'note',
  },
];
for (let i = 0; i < demos.length; i++)
  savePost({
    ...demos[i],
    status: 'published',
    published_at: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
    body: `> Demonstration content. This is sample writing for design review, not an authored article by Sergio.\n\n## A little room to think\n\nA useful tool begins with a clear purpose. This sample article shows how longer paragraphs, headings, and links feel in the reading layout.\n\nWe can start small, learn from using what we build, and leave enough room to change direction. The best next step is often the one that makes an idea tangible.\n\n- Make the first version understandable.\n- Keep the work close to the people using it.\n- Notice what becomes easier.\n\n## Make something worth keeping\n\nThis is a demonstration of **emphasis**, a [public link](https://example.com), and a code snippet.\n\n\`\`\`typescript\nconst idea = 'start small';\n\`\`\`\n\nThere is no hurry to fill every page. Leave a little space for what comes next.`,
  });
db()
  .prepare('INSERT INTO projects(name,description,status,url) VALUES(?,?,?,?)')
  .run(
    'Field Notes · Demo',
    'A demonstration project: a minimal home for ideas and observations.',
    'active',
    'https://example.com',
  );
console.log('Clearly labeled demonstration content added.');
