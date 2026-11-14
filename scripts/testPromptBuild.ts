import '../env';
import { buildCareerAnalysisRequest } from '../ai/careerAnalysis/prompt';

const sampleResumeText = `
Experienced software engineer with 6 years building backend systems in Node.js and TypeScript.
Led a team designing REST APIs, worked with PostgreSQL and Redis, deployed services on AWS.
`;

async function main() {
    const { userQuery } = await buildCareerAnalysisRequest(sampleResumeText, {
        jobTypes: [],
        experienceLevel: [],
        sectors: [],
        locations: [],
        sponsorship: '',
    });
    console.log(userQuery.split('[END OF SHORTLISTED UK OCCUPATIONS]')[0]);
}

main().catch((err) => {
    console.error('Failed:', err);
    process.exit(1);
});
