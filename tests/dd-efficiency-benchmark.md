# Mechanical benchmark

Run `node tests/dd-efficiency-benchmark.mjs` from the repository root.
Requires Node 18+ and Git, no packages or network. Creates isolated repositories
under ignored `tests/.dd-efficiency-scratch/`; leaves evidence there for inspection.

Three cases (pass, unexpected file, failing validator) expose identical checks
through five separate host calls or one batched gate. The baseline checks content
hashes and Git identity, status, both diffs and the same real validator. Assertions
compare verdicts, unexpected counts, validator exits and raw validator output.
Only output presented to a hypothetical host is counted. Setup is excluded from
both sides; internal subprocess count is not claimed to decrease. No token, quota,
cost, complete workflow latency or model judgment saving is measured here.
