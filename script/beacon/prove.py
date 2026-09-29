import json, sys, time, urllib.request, io
from remerkleable.basic import uint8, uint64, uint256, boolean
from remerkleable.byte_arrays import Bytes4, Bytes32, Bytes48, Bytes96, ByteVector, ByteList
Bytes20 = ByteVector[20]
from remerkleable.complex import Container, Vector, List
from remerkleable.bitfields import Bitvector
from remerkleable.tree import gindex_bit_iter

class Fork(Container):
    previous_version: Bytes4
    current_version: Bytes4
    epoch: uint64
class BeaconBlockHeader(Container):
    slot: uint64
    proposer_index: uint64
    parent_root: Bytes32
    state_root: Bytes32
    body_root: Bytes32
class Eth1Data(Container):
    deposit_root: Bytes32
    deposit_count: uint64
    block_hash: Bytes32
class Validator(Container):
    pubkey: Bytes48
    withdrawal_credentials: Bytes32
    effective_balance: uint64
    slashed: boolean
    activation_eligibility_epoch: uint64
    activation_epoch: uint64
    exit_epoch: uint64
    withdrawable_epoch: uint64
class Checkpoint(Container):
    epoch: uint64
    root: Bytes32
class SyncCommittee(Container):
    pubkeys: Vector[Bytes48, 512]
    aggregate_pubkey: Bytes48
class ExecutionPayloadHeader(Container):
    parent_hash: Bytes32
    fee_recipient: Bytes20
    state_root: Bytes32
    receipts_root: Bytes32
    logs_bloom: ByteVector[256]
    prev_randao: Bytes32
    block_number: uint64
    gas_limit: uint64
    gas_used: uint64
    timestamp: uint64
    extra_data: ByteList[32]
    base_fee_per_gas: uint256
    block_hash: Bytes32
    transactions_root: Bytes32
    withdrawals_root: Bytes32
    blob_gas_used: uint64
    excess_blob_gas: uint64
class HistoricalSummary(Container):
    block_summary_root: Bytes32
    state_summary_root: Bytes32
class PendingDeposit(Container):
    pubkey: Bytes48
    withdrawal_credentials: Bytes32
    amount: uint64
    signature: Bytes96
    slot: uint64
class PendingPartialWithdrawal(Container):
    validator_index: uint64
    amount: uint64
    withdrawable_epoch: uint64
class PendingConsolidation(Container):
    source_index: uint64
    target_index: uint64
L40 = 2**40
class BeaconState(Container):
    genesis_time: uint64
    genesis_validators_root: Bytes32
    slot: uint64
    fork: Fork
    latest_block_header: BeaconBlockHeader
    block_roots: Vector[Bytes32, 8192]
    state_roots: Vector[Bytes32, 8192]
    historical_roots: List[Bytes32, 2**24]
    eth1_data: Eth1Data
    eth1_data_votes: List[Eth1Data, 2048]
    eth1_deposit_index: uint64
    validators: List[Validator, L40]
    balances: List[uint64, L40]
    randao_mixes: Vector[Bytes32, 65536]
    slashings: Vector[uint64, 8192]
    previous_epoch_participation: List[uint8, L40]
    current_epoch_participation: List[uint8, L40]
    justification_bits: Bitvector[4]
    previous_justified_checkpoint: Checkpoint
    current_justified_checkpoint: Checkpoint
    finalized_checkpoint: Checkpoint
    inactivity_scores: List[uint64, L40]
    current_sync_committee: SyncCommittee
    next_sync_committee: SyncCommittee
    latest_execution_payload_header: ExecutionPayloadHeader
    next_withdrawal_index: uint64
    next_withdrawal_validator_index: uint64
    historical_summaries: List[HistoricalSummary, 2**24]
    deposit_requests_start_index: uint64
    deposit_balance_to_consume: uint64
    exit_balance_to_consume: uint64
    earliest_exit_epoch: uint64
    consolidation_balance_to_consume: uint64
    earliest_consolidation_epoch: uint64
    pending_deposits: List[PendingDeposit, 2**27]
    pending_partial_withdrawals: List[PendingPartialWithdrawal, 2**27]
    pending_consolidations: List[PendingConsolidation, 2**18]
    proposer_lookahead: Vector[uint64, 64]

t=time.time()
raw=open('state.ssz','rb').read()
state=BeaconState.decode_bytes(raw)
print("decoded", round(time.time()-t), "s; slot", int(state.slot), "validators", len(state.validators), "fields", len(BeaconState.fields()), flush=True)
t=time.time(); state_root=state.hash_tree_root(); print("state root", state_root.hex(), round(time.time()-t),"s", flush=True)

slot=int(state.slot)
B="https://ethereum-beacon-api.publicnode.com"
hdr=json.load(urllib.request.urlopen(urllib.request.Request(f"{B}/eth/v1/beacon/headers/{slot}",headers={"User-Agent":"x"}),timeout=60))["data"]
m=hdr["header"]["message"]
print("header state_root", m["state_root"], "match", m["state_root"]=="0x"+state_root.hex())
header=BeaconBlockHeader(slot=int(m["slot"]),proposer_index=int(m["proposer_index"]),parent_root=bytes.fromhex(m["parent_root"][2:]),state_root=bytes.fromhex(m["state_root"][2:]),body_root=bytes.fromhex(m["body_root"][2:]))
block_root=header.hash_tree_root()
print("block root", block_root.hex(), "api", hdr["root"], "match", hdr["root"]=="0x"+block_root.hex())

def branch(node, gindex):
    """siblings from the leaf up to (not including) the root of `node`"""
    out=[]
    for bit in gindex_bit_iter(gindex)[0]:
        if bit: out.append(node.get_left().merkle_root()); node=node.get_right()
        else:   out.append(node.get_right().merkle_root()); node=node.get_left()
    return list(reversed(out)), node

fixtures=[]
want={"active01":None,"compounding02":None,"exited":None}
n=len(state.validators)
import random
random.seed(8429)
idxs=list(range(0,n, max(1,n//4000)))
for i in idxs:
    v=state.validators[i]; c=bytes(v.withdrawal_credentials)
    far=2**64-1
    if want["active01"] is None and c[0]==1 and int(v.exit_epoch)==far and not v.slashed and i>1000: want["active01"]=i
    if want["compounding02"] is None and c[0]==2 and int(v.exit_epoch)==far and not v.slashed: want["compounding02"]=i
    if want["exited"] is None and c[0]==1 and int(v.withdrawable_epoch)!=far and not v.slashed: want["exited"]=i
    if all(x is not None for x in want.values()): break
print(want)
state_node=state.get_backing(); header_node=header.get_backing()
for name,i in want.items():
    if i is None: continue
    v=state.validators[i]
    # state: depth 6 field 11 ; list: data is the left child ; element i at depth 40
    g_state_field=(1<<6)|11
    b_field,list_node=branch(state_node,g_state_field)
    b_mix,data_node=branch(list_node,2)
    b_elem,leaf=branch(data_node,(1<<40)|i)
    b_hdr,_=branch(header_node,(1<<3)|3)
    br=b_elem+b_mix+b_field+b_hdr
    assert leaf.merkle_root()==v.hash_tree_root()
    fixtures.append({"name":name,"index":i,"slot":slot,"pubkey":"0x"+bytes(v.pubkey).hex(),"withdrawalCredentials":"0x"+bytes(v.withdrawal_credentials).hex(),
        "effectiveBalance":int(v.effective_balance),"slashed":bool(v.slashed),"activationEligibilityEpoch":str(int(v.activation_eligibility_epoch)),"activationEpoch":str(int(v.activation_epoch)),
        "exitEpoch":str(int(v.exit_epoch)),"withdrawableEpoch":str(int(v.withdrawable_epoch)),"blockRoot":"0x"+block_root.hex(),"branch":["0x"+x.hex() for x in br]})
    print(name,i,len(br),"siblings")
json.dump({"fork":"fulu","slot":slot,"blockRoot":"0x"+block_root.hex(),"stateRoot":"0x"+state_root.hex(),"validators":fixtures}, open('beacon_fixture.json','w'), indent=1)
print("wrote beacon_fixture.json")
