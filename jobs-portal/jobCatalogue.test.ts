import test from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { jobsTableForCountry,searchJobsPageRpc,searchJobsCountRpc,jobsCatalogCacheSegment,isQualityUkCatalogue } from './jobsCatalog';
import { toPublicPortalJob,toPublicPortalJobs,portalJobChatColumns } from './publicResponse';
import { toAnonPreviewJob } from './publicPreview/projection';
import { fetchSearchJobPage,fetchSearchMatchCount } from './browseFeed';
import { loadQualityCompanyCounts } from './qualityCompanyCounts';

test('quality mode routes all UK paths consistently and missing RPCs never fall back to raw search', async () => {
    const oldMode=process.env.UK_JOB_CATALOGUE_MODE,oldStrict=process.env.UK_SPONSORSHIP_FEED_MODE;
    try {
        process.env.UK_JOB_CATALOGUE_MODE='quality';process.env.UK_SPONSORSHIP_FEED_MODE='off';
        assert.equal(jobsTableForCountry('uk'),'quality_jobs');
        assert.equal(searchJobsPageRpc('uk'),'search_quality_jobs_page');
        assert.equal(searchJobsCountRpc('uk'),'search_quality_jobs_count');
        assert.equal(jobsTableForCountry('ireland'),'jobs_IR');
        assert.equal(jobsCatalogCacheSegment('uk'),'uk-quality-v1');
        const db={rpc:async()=>({data:null,error:{message:'function missing'}}),from:()=>{throw new Error('Raw fallback is forbidden');}} as unknown as SupabaseClient;
        await assert.rejects(fetchSearchJobPage(db,{roleTerm:'engineer',offset:0,limit:20,catalogCountry:'uk'}),/unavailable/);
        await assert.rejects(fetchSearchMatchCount(db,{roleTerm:'engineer',catalogCountry:'uk'}),/unavailable/);
        process.env.UK_SPONSORSHIP_FEED_MODE='strict';
        assert.equal(jobsTableForCountry('uk'),'quality_sponsorship_jobs');
        assert.equal(searchJobsPageRpc('uk'),'search_quality_sponsorship_jobs_page');
        assert.equal(searchJobsCountRpc('uk'),'search_quality_sponsorship_jobs_count');
        assert.match(portalJobChatColumns('quality_sponsorship_jobs'),/sponsorship_assessment/);
        process.env.UK_JOB_CATALOGUE_MODE='typo';assert.throws(isQualityUkCatalogue,/must be legacy or quality/);
    } finally {
        if(oldMode===undefined)delete process.env.UK_JOB_CATALOGUE_MODE;else process.env.UK_JOB_CATALOGUE_MODE=oldMode;
        if(oldStrict===undefined)delete process.env.UK_SPONSORSHIP_FEED_MODE;else process.env.UK_SPONSORSHIP_FEED_MODE=oldStrict;
    }
});
test('listing evidence survives API reprojection with an explicit public field allowlist', () => {
    const now=new Date().toISOString();
    const job=toPublicPortalJob({id:1,title:'Engineer',url:'https://example.test/one',quality_version:'content-v1',
        last_seen_at:now,description_checked_at:now,salary:'£50,000',reviewer:'private',quality_reasons:['private']});
    assert.equal(job.listingEvidence?.sourceSeenAt,now);
    assert.deepEqual(toPublicPortalJobs([job])[0].listingEvidence,job.listingEvidence);
    const preview=toAnonPreviewJob({...job,listingEvidence:{...job.listingEvidence!,private:'secret'} as any});
    assert.equal(preview.listingEvidence?.checksVersion,'content-v1');
    assert.equal(JSON.stringify(preview).includes('secret'),false);
    assert.equal('url' in preview,false);
    assert.equal('reviewer' in job,false);
    assert.equal(toPublicPortalJob({listingEvidence:{sourceSeenAt:'invalid',descriptionCheckedAt:now,checksVersion:'content-v1'}}).listingEvidence,undefined);
});
test('company counts page server aggregates rather than reading every job', async () => {
    const offsets:number[]=[];
    const db={rpc:async(name:string,p:{p_offset:number;p_sponsorship_only:boolean})=>{
        assert.equal(name,'quality_company_job_counts');assert.equal(p.p_sponsorship_only,true);offsets.push(p.p_offset);
        return {error:null,data:p.p_offset===0?Array.from({length:1000},(_,i)=>({company_id:i+1,job_count:'2'})):[{company_id:1001,job_count:'1'}]};
    }} as unknown as SupabaseClient;
    const rows=await loadQualityCompanyCounts(db,true);
    assert.deepEqual(offsets,[0,1000]);assert.equal(rows.length,1001);assert.equal(rows[0].job_count,2);
});
