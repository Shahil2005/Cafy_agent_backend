/**
 * Runs CV tailoring end to end with the real model and the made-up evaluation CV: the questions, then
 * the tailored CV built from the first option of each question. Prints timings, the questions, the CV
 * and how many unsupported items the fact check removed. Stores nothing.
 *
 *   npx ts-node --transpile-only scripts/agent/tryTailor.ts
 */
import 'dotenv/config';
import { EVAL_CV } from '../../agent/eval/cases';
import { tailorBuild, tailorQuestions } from '../../agent/tailor';

const JD = `Data Analyst - Healthcare Insights
NHS Digital Partners, Leeds (hybrid, 2 days in office). £38,000 - £44,000.
About the role: You will turn NHS operational data into insight for service managers.
Responsibilities:
- Build and maintain Power BI dashboards for waiting-list and A&E performance.
- Write SQL to extract and clean data from our Azure data warehouse.
- Automate recurring reports with Python.
- Present findings to non-technical stakeholders and clinical leads.
Essential: strong SQL; Power BI or Tableau; Python (pandas); clear communication.
Desirable: experience with NHS or healthcare data; Azure; statistics (regression, A/B testing).`;

async function main() {
    const signal = new AbortController().signal;
    let t = Date.now();
    const asked = await tailorQuestions({ cvText: EVAL_CV.text, jobDescription: JD }, { signal });
    console.log(`questions: ${Date.now() - t} ms`, JSON.stringify(asked, null, 2));
    if (!asked.ok) return;
    const answers = asked.questions.map((q) => {
        const option = q.options[0];
        return { questionId: q.id, question: q.text, answer: option.label, ...(q.skill ? { skill: q.skill } : {}), ...(typeof option.confirms === 'boolean' ? { confirmed: option.confirms } : {}) };
    });
    t = Date.now();
    const built = await tailorBuild({ cvText: EVAL_CV.text, jobDescription: JD, answers }, { signal });
    console.log(`build: ${Date.now() - t} ms`);
    console.log(JSON.stringify(built, null, 2));
}

void main();
