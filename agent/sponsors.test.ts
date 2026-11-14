import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentBlock } from './contract';
import { cleanName, closestOption, coreName, editDistance, matchName, splitTradingName } from './sponsors/match';
import { createSponsorTools, searchRegister, type RegisterRow } from './tools/sponsors';
import { listUkSponsorshipRegister } from '../jobs-portal/service';

const rows: RegisterRow[] = [
    { organisationName: 'Barclays Bank UK PLC', townCity: 'London', county: 'Greater London', typeRating: 'Worker (A rating)', route: 'Skilled Worker' },
    { organisationName: 'Barclays Bank UK PLC', townCity: 'London', county: 'Greater London', typeRating: 'Worker (A rating)', route: 'Global Business Mobility: Senior or Specialist Worker' },
    { organisationName: 'J Sainsbury plc t/a Sainsburys', townCity: 'London', county: '', typeRating: 'Worker (A rating)', route: 'Skilled Worker' },
    { organisationName: 'Apex Care Ltd', townCity: 'Leeds', county: 'West Yorkshire', typeRating: 'Worker (A rating)', route: 'Health and Care Worker' },
    { organisationName: 'Apex Engineering Limited', townCity: 'Glasgow', county: '', typeRating: 'Worker (B rating)', route: 'Skilled Worker' },
    { organisationName: 'Apex Digital Services Ltd', townCity: 'Manchester', county: '', typeRating: 'Worker (A rating)', route: 'Skilled Worker' },
    { organisationName: "Marks & Spencer plc", townCity: 'London', county: '', typeRating: 'Worker (A rating)', route: 'Skilled Worker' },
    { organisationName: "L'Oréal (UK) Limited", townCity: 'London', county: '', typeRating: 'Worker (A rating)', route: 'Skilled Worker' },
];

test('names are normalised: case, punctuation, accents, & and legal suffixes', () => {
    assert.equal(coreName('Barclays Bank UK PLC'), 'barclays bank');
    assert.equal(cleanName('Marks & Spencer'), 'marks and spencer');
    assert.equal(coreName("L'Oréal (UK) Limited"), 'loreal');
    assert.deepEqual(splitTradingName('J Sainsbury plc t/a Sainsburys'), { legal: 'J Sainsbury plc', trading: 'Sainsburys' });
    assert.equal(editDistance('barcalys', 'barclays'), 1, 'adjacent swap counts as one typo');
});

test('exact, all-words, prefix and typo matches are recognised; unrelated names are not', () => {
    assert.equal(matchName('Barclays', 'Barclays Bank UK PLC')?.tier, 'all-words');
    assert.equal(matchName('barcalys', 'Barclays Bank UK PLC')?.tier, 'typo');
    assert.equal(matchName('Accentur', 'Accenture (UK) Limited')?.tier, 'prefix');
    assert.equal(matchName('Barclays', 'Lloyds Bank plc'), null);
    assert.equal(matchName('ABC', 'ABD Ltd'), null, 'no typos allowed on very short words');
});

test('trading names, special characters and grouping of routes work', () => {
    const sainsburys = searchRegister(rows, { name: "Sainsbury's" });
    assert.equal(sainsburys.items[0]!.name, 'J Sainsbury plc');
    assert.equal(sainsburys.items[0]!.tradingAs, 'Sainsburys');
    assert.equal(searchRegister(rows, { name: 'marks and spencer' }).items[0]!.name, 'Marks & Spencer plc');
    assert.equal(searchRegister(rows, { name: 'loreal' }).items.length, 1);
    const barclays = searchRegister(rows, { name: 'Barclays' }).items[0]!;
    assert.equal(barclays.routes.size, 2, 'one company card lists all its routes');
});

test('filters: city, county, rating and fuzzy route names', () => {
    assert.equal(searchRegister(rows, { city: 'leeds' }).total, 1);
    assert.equal(searchRegister(rows, { county: 'west yorkshire' }).total, 1);
    assert.equal(searchRegister(rows, { route: 'skiled worker', rating: 'B' }).items[0]!.name, 'Apex Engineering Limited');
    assert.equal(searchRegister(rows, { route: 'health care' }).route, 'Health and Care Worker');
    assert.equal(closestOption('xyzzy', ['Skilled Worker']), undefined);
});

function ctx() {
    const blocks: AgentBlock[] = [];
    return { blocks, ctx: { uid: 'u', signal: new AbortController().signal, cv: null, emit: (_: string, b: AgentBlock) => blocks.push(b) } };
}

test('a name with several weak matches asks "did you mean" instead of guessing', async () => {
    const [tool] = createSponsorTools({ load: async () => rows, aliases: async () => [] });
    const c = ctx();
    const out = (await tool!.run({ name: 'Apex' }, c.ctx)) as { ambiguous?: boolean };
    // "Apex" is a whole word in three names, so all are strong matches: listed, not ambiguous.
    assert.equal(out.ambiguous, undefined);
    const typo = ctx();
    const amb = (await tool!.run({ name: 'Apexx' }, typo.ctx)) as { ambiguous?: boolean };
    assert.equal(amb.ambiguous, true);
    const card = (typo.blocks[0] as Extract<AgentBlock, { kind: 'sponsorList' }>).card;
    assert.ok(card.didYouMean && card.didYouMean.length >= 2);
});

test('not found is reported plainly, and empty criteria ask for more', async () => {
    const [tool] = createSponsorTools({ load: async () => rows, aliases: async () => [] });
    const c = ctx();
    const out = (await tool!.run({ name: 'Zyxcorp Industries' }, c.ctx)) as { found: boolean; instruction?: string };
    assert.equal(out.found, false);
    assert.match(out.instruction!, /Not found/);
    assert.equal(c.blocks.length, 0);
    assert.equal(((await tool!.run({}, c.ctx)) as { error?: string }).error, 'NEED_CRITERIA');
});

test('brand names from CAFY company data map to the legal register name', async () => {
    const [tool] = createSponsorTools({ load: async () => rows, aliases: async () => ['Barclays Bank UK PLC'] });
    const c = ctx();
    const out = (await tool!.run({ name: 'Barclaycard' }, c.ctx)) as { results: Array<{ name: string }> };
    assert.equal(out.results[0]!.name, 'Barclays Bank UK PLC');
});

test('the real register (all rows) is searched quickly and correctly', async () => {
    const register = await listUkSponsorshipRegister();
    assert.ok(register.length > 100_000, `register rows: ${register.length}`);
    assert.ok(register.some((r) => r.county), 'county column is loaded');
    const started = Date.now();
    const result = searchRegister(register, { name: 'barcalys' });
    const ms = Date.now() - started;
    assert.ok(result.items.some((i) => /barclays/i.test(i.name)), 'typo finds Barclays');
    assert.ok(ms < 3000, `search took ${ms}ms`);
});

test('a route named in the message is applied even if the model forgets it', async () => {
    const { routeInMessage } = await import('./tools/sponsors');
    assert.equal(routeInMessage('sponsors in leeds for health and care', rows), 'Health and Care Worker');
    assert.equal(routeInMessage('skilled worker sponsors in glasgow', rows), 'Skilled Worker');
    assert.equal(routeInMessage('sponsors in leeds', rows), undefined);
    const real = [{ ...rows[0]!, route: 'Skilled Worker' }];
    assert.equal(routeInMessage('care worker sponsors in leeds', real), 'Skilled Worker', 'Health and Care visas sit under the Skilled Worker licence');
    const [tool] = createSponsorTools({ load: async () => rows, aliases: async () => [] });
    const c = ctx();
    const out = (await tool!.run({ city: 'leeds' }, { ...c.ctx, userMessage: 'sponsors in leeds for health and care' })) as { routeUsed?: string; total: number };
    assert.equal(out.routeUsed, 'Health and Care Worker');
    assert.equal(out.total, 1);
});
