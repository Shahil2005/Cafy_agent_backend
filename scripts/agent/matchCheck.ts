/**
 * Accuracy check for CAFY Match in the TESTING Supabase: top jobs for 10 made-up CVs, for a person to judge.
 * Reads only (the ranking function changes nothing). No real CV is used.
 *
 *   npx ts-node --transpile-only scripts/agent/matchCheck.ts
 *   npx ts-node --transpile-only scripts/agent/matchCheck.ts --only=nurse --limit=20
 */
import 'dotenv/config';
import { chunkCv } from '../../agent/cv/chunk';

const TESTING_REF = 'icsoljtmqwqibwpqhwyf';
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string | undefined]));
const only = args.only;
const limit = args.limit ? Number(args.limit) : 10;

const url = process.env.SUPABASE_URL?.trim() ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '';
const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

interface TestCv { id: string; years: number; keywords: string[]; text: string }

const CVS: TestCv[] = [
    { id: 'data-analyst', years: 3, keywords: ['SQL', 'Python', 'Power BI', 'Tableau', 'Data Analyst', 'Excel', 'dashboards', 'A/B testing'], text: `Professional summary
Data analyst with 3 years of experience turning retail and subscription data into decisions for commercial teams.
Experience
Data Analyst, online retailer, Manchester, 2022 to 2025. Built SQL pipelines and Power BI dashboards for trading and marketing teams. Ran A/B tests on checkout changes and reported the results to senior stakeholders. Automated weekly reporting in Python, saving a day each week.
Education
BSc Mathematics, University of Leeds.
Skills
SQL, Python, pandas, Power BI, Tableau, Excel, statistics, A/B testing, stakeholder reporting.` },
    { id: 'nurse', years: 6, keywords: ['Registered Nurse', 'NMC', 'acute', 'patient care', 'medication', 'ward', 'NHS'], text: `Professional summary
NMC registered adult nurse with 6 years of experience on acute medical wards in the NHS.
Experience
Staff Nurse, NHS hospital trust, Birmingham, 2019 to 2025. Delivered patient care on a 28-bed acute medical ward, administered medication, managed deteriorating patients using NEWS2, supervised student nurses and coordinated discharge with families and community teams.
Education
BSc Adult Nursing, Birmingham City University.
Certifications
NMC registration, Immediate Life Support, IV therapy, venepuncture.` },
    { id: 'chef', years: 8, keywords: ['Sous Chef', 'Head Chef', 'kitchen', 'menu', 'food hygiene', 'HACCP', 'restaurant'], text: `Professional summary
Sous chef with 8 years of experience in busy restaurant and hotel kitchens.
Experience
Sous Chef, city centre hotel restaurant, Edinburgh, 2020 to 2025. Ran the kitchen service for 150 covers, wrote seasonal menus, controlled food costs and stock, led a brigade of 8, and kept HACCP records.
Chef de Partie, gastropub, Glasgow, 2017 to 2020.
Certifications
Level 3 Food Hygiene, Level 3 Food Safety Supervision.
Skills
Menu development, stock control, staff training, HACCP, fine dining.` },
    { id: 'lawyer', years: 4, keywords: ['Solicitor', 'commercial', 'contracts', 'SRA', 'corporate', 'due diligence', 'legal'], text: `Professional summary
Commercial solicitor, qualified 4 years, advising companies on contracts and corporate transactions.
Experience
Associate Solicitor, regional law firm, Bristol, 2021 to 2025. Drafted and negotiated commercial contracts, supplier agreements and terms of business. Ran due diligence on mergers and acquisitions, and advised directors on data protection and company law.
Education
LLB Law, University of Bristol. Legal Practice Course. Admitted to the roll of solicitors, SRA.
Skills
Contract drafting, negotiation, due diligence, GDPR, client management.` },
    { id: 'teacher', years: 5, keywords: ['Teacher', 'QTS', 'secondary', 'mathematics', 'curriculum', 'safeguarding', 'lesson planning'], text: `Professional summary
Secondary mathematics teacher with QTS and 5 years of classroom experience.
Experience
Teacher of Mathematics, academy school, Leicester, 2020 to 2025. Taught KS3, GCSE and A level classes, planned lessons and schemes of work, tracked pupil progress, supported SEND pupils, and acted as form tutor following safeguarding procedures.
Education
PGCE Secondary Mathematics, University of Nottingham. BSc Mathematics. Qualified Teacher Status.
Skills
Lesson planning, behaviour management, assessment, safeguarding, curriculum design.` },
    { id: 'retail', years: 2, keywords: ['Sales Assistant', 'retail', 'customer service', 'till', 'stock', 'merchandising'], text: `Professional summary
Friendly retail sales assistant with 2 years of experience in fashion and grocery stores.
Experience
Sales Assistant, high street fashion store, Cardiff, 2023 to 2025. Served customers, worked the till, handled returns, replenished stock and helped with visual merchandising and weekend opening.
Customer Assistant, supermarket, Cardiff, 2022 to 2023.
Education
A levels, Cardiff and Vale College.
Skills
Customer service, cash handling, stock replenishment, teamwork, merchandising.` },
    { id: 'mech-engineer', years: 7, keywords: ['Mechanical Engineer', 'CAD', 'SolidWorks', 'FEA', 'design', 'manufacturing', 'CEng'], text: `Professional summary
Mechanical design engineer with 7 years of experience in aerospace and manufacturing.
Experience
Mechanical Design Engineer, aerospace supplier, Derby, 2018 to 2025. Designed machined and sheet metal components in SolidWorks, ran FEA stress analysis, wrote test plans and supported production with root cause investigations and design for manufacture.
Education
MEng Mechanical Engineering, University of Sheffield.
Skills
SolidWorks, FEA, GD&T, design for manufacture, FMEA, root cause analysis.` },
    { id: 'marketing', years: 4, keywords: ['Digital Marketing', 'SEO', 'PPC', 'Google Ads', 'content', 'social media', 'campaigns', 'Marketing Executive'], text: `Professional summary
Digital marketing executive with 4 years of experience running paid and organic campaigns for B2C brands.
Experience
Digital Marketing Executive, consumer brand, London, 2021 to 2025. Managed Google Ads and Meta campaigns, improved SEO and organic traffic, wrote email and social media content, and reported on spend and return in Google Analytics.
Education
BA Marketing, University of Portsmouth.
Skills
SEO, PPC, Google Ads, Meta Ads, HubSpot, Google Analytics, copywriting, campaign reporting.` },
    { id: 'graduate', years: 0, keywords: ['Graduate', 'Economics', 'Excel', 'research', 'analysis', 'internship'], text: `Professional summary
Recent economics graduate looking for a first role in business, finance or research.
Experience
Summer Intern, small consultancy, London, 2024. Collected market data, built Excel models and helped prepare client slides.
Student Ambassador, University of Warwick, 2022 to 2024.
Education
BSc Economics, University of Warwick, 2:1, 2025. Modules in econometrics, finance and public policy. Dissertation on regional wages.
Skills
Excel, Stata, research, written reports, presentations.` },
    // years = time in the field they now want (1), not their whole career: the backend must work this out too.
    { id: 'career-changer', years: 1, keywords: ['Software Developer', 'JavaScript', 'React', 'Node.js', 'bootcamp', 'project management', 'logistics'], text: `Professional summary
Former logistics manager with 9 years of operations experience, now retrained as a junior software developer.
Experience
Logistics Manager, distribution company, Leeds, 2015 to 2024. Managed a team of 20, delivery schedules and supplier contracts.
Personal projects, 2024 to 2025. Built a route planning web app with React, Node.js and PostgreSQL, deployed on AWS, with automated tests.
Education
Full stack software development bootcamp, 2024.
Skills
JavaScript, TypeScript, React, Node.js, SQL, Git, project management, team leadership.` },
];

type Extractor = (texts: string[], options: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

async function main(): Promise<void> {
    if (!url.includes(TESTING_REF)) throw new Error('SUPABASE_URL is not the testing project: refusing to run');
    const { pipeline } = (await new Function('m', 'return import(m)')('@huggingface/transformers')) as { pipeline: (task: string, model: string, opts: object) => Promise<Extractor> };
    const extractor = await pipeline('feature-extraction', 'Supabase/gte-small', { dtype: 'fp32' });

    for (const cv of CVS.filter((c) => !only || c.id === only)) {
        const chunks = chunkCv(cv.text);
        const vectors: number[][] = [];
        for (const chunk of chunks) vectors.push((await extractor([chunk.text], { pooling: 'mean', normalize: true })).tolist()[0]!);
        const started = Date.now();
        const res = await fetch(`${url}/rest/v1/rpc/agent_match_jobs`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                p_query: vectors.map((v) => ({ v: `[${v.map((x) => Number(x.toFixed(5))).join(',')}]`, w: 1 })),
                p_keywords: cv.keywords,
                p_cv_years: cv.years,
                p_filters: {},
                p_limit: limit,
            }),
        });
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        if (!res.ok) {
            console.log(`\n## ${cv.id}: HTTP ${res.status} after ${seconds}s ${(await res.text()).slice(0, 200)}`);
            continue;
        }
        const rows = (await res.json()) as Array<{ job_id: number; meaning: number; keyword: number; seniority: string | null; band: number }>;
        const ids = rows.map((r) => r.job_id).join(',');
        const details = (await (await fetch(`${url}/rest/v1/jobs?select=id,title,location,company_id&id=in.(${ids})`, { headers })).json()) as Array<{ id: number; title: string; location: string | null; company_id: number | null }>;
        const companyIds = [...new Set(details.map((d) => d.company_id).filter(Boolean))].join(',');
        const companies = (await (await fetch(`${url}/rest/v1/companies?select=id,trading_name,companies_house_name&id=in.(${companyIds})`, { headers })).json()) as Array<{ id: number; trading_name?: string | null; companies_house_name?: string | null }>;
        console.log(`\n## ${cv.id} (${cv.years} years, ${chunks.length} CV pieces, ${seconds}s)`);
        rows.forEach((r, i) => {
            const job = details.find((d) => d.id === r.job_id);
            const company = companies.find((c) => String(c.id) === String(job?.company_id));
            console.log(`${String(i + 1).padStart(2)}. ${job?.title ?? '?'} | ${company?.trading_name ?? company?.companies_house_name ?? '-'} | ${job?.location ?? '-'} | meaning ${r.meaning.toFixed(3)} kw ${r.keyword.toFixed(2)} band ${r.band}${r.seniority ? ` ${r.seniority}` : ''} | id ${r.job_id}`);
        });
    }
}

main().catch((error) => {
    console.error('Stopped:', (error as Error).message);
    process.exitCode = 1;
});
