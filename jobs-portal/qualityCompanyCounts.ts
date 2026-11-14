import type { SupabaseClient } from '@supabase/supabase-js';

/** Server aggregation, paged by employer rather than downloading the job catalogue. */
export async function loadQualityCompanyCounts(db: Pick<SupabaseClient,'rpc'>,sponsorshipOnly:boolean): Promise<Array<{company_id:number;job_count:number}>> {
    const rows:Array<{company_id:number;job_count:number}>=[];
    const pageSize=1000;
    for (let offset=0; ; offset+=pageSize) {
        const {data,error}=await db.rpc('quality_company_job_counts',{p_sponsorship_only:sponsorshipOnly,p_offset:offset,p_limit:pageSize});
        if (error) throw new Error('Company listings are temporarily unavailable. Please try again.');
        const page=(data||[]) as Array<{company_id:number;job_count:number|string}>;
        for(const row of page) rows.push({company_id:Number(row.company_id),job_count:Number(row.job_count)});
        if(page.length<pageSize) return rows;
    }
}
