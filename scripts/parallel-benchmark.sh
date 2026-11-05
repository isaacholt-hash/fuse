#!/usr/bin/env bash
# Real owner-local Git/sandbox/HTTP fixtures. Synthetic model replies; no provider credentials.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
mkdir -p src-tauri/target
parallel_bench_start="$(python3 -c 'import time;print(time.monotonic_ns())')"
cargo test --manifest-path src-tauri/Cargo.toml --features server --lib code_worktrees:: -- --nocapture --test-threads=1 2>&1 | tee src-tauri/target/parallel-native-benchmark.log
pnpm exec vitest run src/parallel src/storage/requestBudget.test.ts src/ui/ParallelRuns.test.tsx src/ui/RunCard.test.tsx --reporter=default --reporter=json --outputFile=src-tauri/target/parallel-shared-benchmark.json
bash scripts/parallel-web.sh
python3 - "$parallel_bench_start" <<'VERIFY'
import json,re,subprocess,sys,time
from pathlib import Path
native=Path('src-tauri/target/parallel-native-benchmark.log').read_text()
result=re.search(r'test result: ok\. (\d+) passed; 0 failed',native)
assert result, 'Native parallel suite did not pass'
shared=json.loads(Path('src-tauri/target/parallel-shared-benchmark.json').read_text())
assert shared['numFailedTests']==0 and shared['numPassedTests']>0
web=json.loads(Path('e2e/screenshots/parallel/result.json').read_text())
for key in ['actualNativeWorktrees','callerNavigatedAway','parentUnchanged','parentIndexUnchanged','integrated','conflictPreserved','staleParentRefused','cancelCreatesNoCommit','acknowledgementRecoveredFromJournal']:
    assert web[key] is True,key
assert web['liveProviderCalls']==0 and web['automaticProviderRequestsAfterReview']==0
assert web['actualSpend']==web['rootSpend'] and web['unknown']==0
assert len(web['approvedChildCommits'])==1 and web['committedChildren']==2
schema=len(list(Path('src-tauri/migrations').glob('*.sql')))
proof={'benchmark':'M16 recorded parallel Code','syntheticModels':True,'liveProviderCalls':0,'schema':schema,'priceVersion':json.loads(Path('data/models.json').read_text())['price_version'],'elapsedMs':round((time.monotonic_ns()-int(sys.argv[1]))/1_000_000),'source':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'sourceDirty':subprocess.run(['git','diff','--quiet'],check=False).returncode!=0,'nativePassed':int(result.group(1)),'sharedPassed':shared['numPassedTests'],'sharedSkipped':shared['numPendingTests'],'web':web}
Path('src-tauri/target/parallel-benchmark.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps({k:v for k,v in proof.items() if k!='web'}))
VERIFY
