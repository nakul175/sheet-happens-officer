import { describe, expect, it, vi } from 'vitest';
import { assertBidSubmissionFields, guardBidSubmissionWrite } from '@/lib/bid-submission-policy';
const complete = { probability: 0, netFeeRevenueUsd: 0, athenaEntity: 'ATHENA_INDIA' };
describe('3049 owner-approved Bid submission gate', () => {
  it.each(['st_bid_submitted', 'st_bid_won', 'st_bid_ongoing'])('requires all three fields at %s, including zero as valid', (stage) => {
    expect(() => assertBidSubmissionFields('DEAL_BID', stage, complete)).not.toThrow();
    for (const key of Object.keys(complete)) expect(() => assertBidSubmissionFields('DEAL_BID', stage, {...complete, [key]: null})).toThrow();
  });
  it.each(['st_bid_identified','st_bid_gonogo','st_bid_preparing','st_bid_nogo','st_bid_onhold','st_bid_lost'])('does not impose unapproved requirements on %s', stage => {
    expect(() => assertBidSubmissionFields('DEAL_BID', stage, {})).not.toThrow();
    expect(() => assertBidSubmissionFields('DEAL_PROACTIVE', 'st_bid_submitted', {})).not.toThrow();
  });
  it('locks project before reading fresh details and rejects a concurrent null clear on stage move', async () => {
    const lock = vi.fn().mockResolvedValue([{ pipelineId:'bid', key:'DEAL_BID', stageId:'st_bid_identified' }]);
    const read = vi.fn().mockResolvedValue({...complete, probability:null});
    await expect(guardBidSubmissionWrite({$queryRaw:lock, dealDetails:{findUnique:read}} as never, 'owned', {}, 'st_bid_submitted', 'bid')).rejects.toMatchObject({status:409});
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]);
  });
  it('checks current locked stage for direct PATCH/Undo and permits a valid atomic fill', async () => {
    const tx = {$queryRaw:vi.fn().mockResolvedValue([{pipelineId:'bid',key:'DEAL_BID',stageId:'st_bid_submitted'}]),dealDetails:{findUnique:vi.fn().mockResolvedValue(complete)}};
    await expect(guardBidSubmissionWrite(tx as never, 'owned', {netFeeRevenueUsd:null})).rejects.toMatchObject({status:409});
    await expect(guardBidSubmissionWrite(tx as never, 'owned', {probability:100})).resolves.toEqual(complete);
  });
  it('refuses disappeared or concurrently converted projects before any write', async () => {
    const tx={$queryRaw:vi.fn().mockResolvedValue([]),dealDetails:{findUnique:vi.fn()}};
    await expect(guardBidSubmissionWrite(tx as never,'owned',{})).rejects.toMatchObject({status:409});
    tx.$queryRaw.mockResolvedValue([{pipelineId:'other',key:'DEAL_PROACTIVE',stageId:'other'}]);
    await expect(guardBidSubmissionWrite(tx as never,'owned',{},'st_bid_submitted','bid')).rejects.toMatchObject({status:409});
    expect(tx.dealDetails.findUnique).not.toHaveBeenCalled();
  });
});
