import '../env';
import { matchSocOccupations } from '../ai/careerAnalysis/vectorSearch';

const sampleResumeText = `
Experienced software engineer with 6 years building backend systems in Node.js and TypeScript.
Led a team designing REST APIs, worked with PostgreSQL and Redis, deployed services on AWS.
Strong background in system architecture, CI/CD pipelines, and mentoring junior developers.
`;

async function main() {
    console.log('Embedding sample resume and searching for top matches...\n');
    const matches = await matchSocOccupations(sampleResumeText, 5);

    for (const m of matches) {
        console.log(`${m.soc_code} | ${m.title} | similarity=${m.similarity.toFixed(4)}`);
        console.log(`   category: ${m.category}`);
    }
}

main().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
