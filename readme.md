# Caido Action Bench

A GitHub Action that collects one [Hotpath](https://github.com/caido/hotpath) report per run, compares configured functions with a baseline stored s3 bucket, and updates one pull request comment. The action does not build or run benchmarks.

## How it works

- Each benchmark job runs the action in `collect` mode with one raw Hotpath JSON report and uploads it to a unique temporary object.
- A final job waits for all benchmark jobs, checks that every configured Criterion group and function was reported, then merges the reports.
- On a pull request, the final job compares the merged report with the latest baseline for the configured reference branch.
- On a successful push to that branch, the final job publishes one merged baseline.
- Temporary reports are deleted after successful finalization. Configure the R2 lifecycle rule below as a fallback for interrupted runs.
- Baselines are stored at `action-bench/<owner>/<repo>/<branch>/<commit-sha>/merged.json`.

## Configuration

Create a `benchmarks.yml` file:

```yaml
referenceBranch: main
retention: 5

maxRegressionPercent:
  timing: 20
  allocations: 10

benchmarks:
  sum/memory:
    "hotpath_demo::sum_with_allocations":
      timing: 50
    "hotpath_demo::sum_optimized": {}

  sum/sqlite:
    "hotpath_demo::sum_sql_low": {}
    "hotpath_demo::sum_sql_optimized": {}
```

`maxRegressionPercent` defines the default thresholds. A metric without a threshold is not compared. Each key under `benchmarks` is a Criterion group prefix: `sum/memory` matches reports named `sum/memory` and `sum/memory/...`, but not `sum/memoryx`. Function IDs must exactly match a function's `name` in the Hotpath report. Values under a function ID are optional per-metric overrides; omitted metrics inherit the global threshold, and `{}` inherits all global thresholds. A more-specific group prefix can override a broader group's thresholds. Unconfigured groups and functions are ignored.

## Usage

The benchmark job can be a matrix. Each matrix run writes one raw Hotpath report and collects that report:

```yaml
permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  benchmark:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        include:
          - benchmark_id: sum/memory/with_allocations
            report_name: memory-with-allocations
          - benchmark_id: sum/memory/optimized
            report_name: memory-optimized
          - benchmark_id: sum/sqlite/line_by_line
            report_name: sql-line-by-line
          - benchmark_id: sum/sqlite/agregation_sql
            report_name: sql-agregation
    steps:
      - uses: actions/checkout@v7

      # Build and run this matrix benchmark with Hotpath and Callgrind.
      # Write exactly one raw Hotpath report to $RUNNER_TEMP/report.json.

      - name: Collect Hotpath report
        uses: caido/action-bench@v1
        with:
          mode: collect
          config: benchmarks.yml
          report: ${{ runner.temp }}/report.json
          bucket: caido-benchmarks
        env:
          R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}

  compare:
    needs: benchmark
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - name: Compare or publish baseline
        uses: caido/action-bench@v1
        with:
          mode: finalize
          config: benchmarks.yml
          bucket: caido-benchmarks
          github-token: ${{ secrets.GITHUB_TOKEN }}
        env:
          R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

The `compare` job depends on the complete benchmark matrix, so it will not publish a partial baseline if a benchmark job fails. The R2 credentials need permission to list, read, write, and delete objects in the bucket. The `GITHUB_TOKEN` needs `issues: write` (or `pull-requests: write`) to create or update a PR comment. For pull requests from forks, GitHub may restrict this token to read-only access.
