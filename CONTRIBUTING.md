# Contributing to loadsketch

Thanks for your interest in contributing to loadsketch! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How to Contribute](#how-to-contribute)
- [Development Setup](#development-setup)
- [Contribution Workflow](#contribution-workflow)
- [Coding Standards](#coding-standards)
- [Adding a Terraform Resource Mapping](#adding-a-terraform-resource-mapping)
- [Commit Messages](#commit-messages)
- [Pull Request Process](#pull-request-process)

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help create a welcoming environment for all contributors

## How to Contribute

### Reporting Bugs

If you find a bug, please open an issue with:
- A clear, descriptive title
- Steps to reproduce the issue
- Expected vs actual behavior
- A share link to the design (the **Share** button in the top bar), or the design JSON
- Your browser and operating system
- Screenshots if applicable

If the simulation gives a result you think is wrong, use the issue form "The simulation differs from a real system": say what you expected and why (a formula, a paper, or how the real system behaves).

### Suggesting Features

Feature requests are welcome! Please:
- Check if the feature has already been requested
- Explain the use case and why it would be valuable
- Provide examples of how it would work

### Contributing Code

We welcome code contributions! Areas where we especially need help:
- **Examples**: new designs and scenarios that teach one idea well
- **Design briefs**: a new problem that starts from requirements (`src/learn/briefs.ts`), with a reference design that passes and a first design that does not
- **Component kinds**: a new kind of component. It is a code change in several places; [AGENTS.md](AGENTS.md) lists them under "新增一種元件"
- **Model accuracy**: cases where the simulation differs from how real systems behave
- **Terraform import**: more resource types and providers
- **Translations**: English text in `src/i18n/en.ts`
- **Bug fixes**: check our [issues](https://github.com/minchenlee/loadsketch/issues)

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 22.18 or later

### Initial Setup

```bash
# Fork the repository on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/loadsketch.git
cd loadsketch

# Install dependencies
npm install

# Run in development mode
npm run dev        # the simulator: http://127.0.0.1:5317/app/
```

### Project Structure

```
loadsketch/
├── src/
│   ├── schema/             # File formats (zod), component kinds, design checks
│   ├── engine/             # Discrete-event simulation (no browser APIs)
│   ├── learn/              # Lessons, on-call incidents, design briefs, cost, diagnosis
│   ├── import/terraform/   # Terraform plan JSON -> design
│   ├── app/                # Simulator UI (React, React Flow)
│   ├── site/               # Intro site
│   └── i18n/               # Translations
├── cli/                    # Command line
├── examples/               # Designs and scenarios (JSON)
├── tests/                  # Unit tests (vitest)
└── e2e/                    # UI tests (Playwright, headless)
```

[AGENTS.md](AGENTS.md) says where each kind of change goes (a new component kind, a new example, an engine behavior). Read it before a larger change. It is written in Traditional Chinese with an English summary at the end.

## Contribution Workflow

### 1. Fork and Clone

Fork the repository to your GitHub account, then clone your fork.

### 2. Create a Branch

Always create a feature branch for your work:

```bash
# For new features
git checkout -b feature/your-feature-name

# For bug fixes
git checkout -b fix/bug-description

# For documentation
git checkout -b docs/what-you-are-documenting
```

### 3. Make Changes

- Write clear, readable code
- Follow existing code style
- Add tests (see the rules below)
- Update documentation if needed

### 4. Test Your Changes

```bash
npm run test:quick     # about 10 s: fast unit tests and the i18n check. Run it after every change
npm run typecheck
npx vitest run tests/golden.test.ts    # after an engine change
npx playwright test                    # UI tests, about 3 minutes, headless
```

### 5. Commit Your Changes

See [Commit Messages](#commit-messages) section below.

### 6. Push and Create PR

```bash
# Push to your fork
git push -u origin feature/your-feature-name
```

Then open a Pull Request on GitHub from your fork to the main repository.

## Coding Standards

### Rules the tests enforce

- **A test that fails first.** For a bug fix or an engine behavior change, write a test that fails before the fix.
- **Golden test.** `tests/golden.test.ts` runs every example with a fixed seed and compares a hash of the numbers. A change that is not meant to change behavior must keep every hash. When you mean to change behavior, run `UPDATE_GOLDEN=1 npx vitest run tests/golden.test.ts` and say why in the commit message.
- **UI text.** The Traditional Chinese text in the code is the message id: write `t('…')`. Then run `node scripts/i18n-extract.ts` and fill in the English in `src/i18n/en.ts`. The test fails while an entry is empty.
- **The file format only gains optional fields.** Old design files and share links must still open. After a format change, run `npm run schema`.
- **No native `<select>` or number inputs.** Use `Select` and `NumberField` in `src/app/components/Select.tsx`.
- **Speed budgets use CPU time** (`cpuMs()` in `tests/helpers.ts`), not wall-clock time.

### TypeScript and React

- Use TypeScript for type safety
- The schema and the engine must not use the DOM or React (`tests/boundary.test.ts` checks this)
- Keep components small and focused
- Add comments for complex logic

### UI

Read [docs/design-system.md](docs/design-system.md) before a UI change. In short: glass only for things that float over other content, the spring curve only on `transform`, no decorative motion on data, and every animation off under `prefers-reduced-motion`. Check light and dark themes.

### Style

- Two spaces for indentation (project convention)
- Follow the style of the code around your change

## Adding a Terraform Resource Mapping

`src/import/terraform/index.ts` turns `terraform show -json` output into a loadsketch design (`importTerraform()`). It parses the plan, builds a resource graph, groups identical instances, runs one rule per resource type, fills missing performance assumptions from an instance table, runs static checks, and attaches `source` metadata to every node and edge.

### 1. Decide: Design Node or Folded Resource?

- **Folded resource** (plumbing or configuration that only shapes another node, such as `aws_lb_target_group`, `aws_route53_health_check`, or `aws_sqs_queue_redrive_policy`): add its Terraform resource type to `FOLDED` in `src/import/terraform/rules.ts`, `PLATFORM_FOLDED` in `src/import/terraform/rules-platform.ts`, or `SERVERLESS_FOLDED` in `src/import/terraform/rules-serverless.ts`, pointing to an `'import.folded.*'` message id in `src/i18n/importMessages.ts`.
- **Design node** (a component that handles, queues, caches, routes, or stores traffic, mapped to a `kind` in `src/schema/kinds.ts`): write a `Rule` and register it in `RULES` (`src/import/terraform/rules.ts`), `PLATFORM_RULES` (`src/import/terraform/rules-platform.ts`), or `SERVERLESS_RULES` (`src/import/terraform/rules-serverless.ts`).

### 2. Write the Rule (Example from the Repo)

Each rule has type `Rule` in `src/import/terraform/rule-kit.ts`: `(rs: PlanResource[], g: ResourceGraph) => RuleOut | Fold`. `rs` holds one or more grouped instances of the same resource block (from `groupInstances()` in `src/import/terraform/graph.ts`).

Here is `cacheCluster` from `src/import/terraform/rules-platform.ts`:

```ts
const cacheCluster: Rule = ([c], g) => {
  // A member of a replication group: that group is the node.
  if (refsTo(g.plan, c.expressions.replication_group_id, /^aws_elasticache_replication_group$/).length) return { fold: 'import.folded.cacheMember' };
  const out = empty('cache');
  const n = num(c.values.num_cache_nodes) ?? 1;
  set(out, 'instances', n, setOr(c, 'num_cache_nodes', DEFAULTS.elastiCache.numCacheClusters.source));
  out.facts.numCacheClusters = { value: n, origin: out.origins.instances };
  out.facts.automaticFailover = { value: false, origin: awsDefault(c, 'automatic_failover_enabled', DEFAULTS.elastiCache.automaticFailover.source) };
  if (typeof c.values.node_type === 'string') out.facts.nodeType = { value: c.values.node_type, origin: iac(c, 'node_type') };
  if (typeof c.values.engine === 'string') out.facts.engine = { value: c.values.engine, origin: iac(c, 'engine') };
  out.notes.push({ id: 'import.approx.hitRatio' });
  return out;
};
```

Key fields on `RuleOut` (`src/import/terraform/rule-kit.ts`):

- `kind`: component kind from `KINDS` in `src/schema/kinds.ts`.
- `params` and `origins`: loadsketch parameters and where each value came from.
- `facts`: metadata that static checks or `fillFromTable()` (`src/import/terraform/fill.ts`) need even if there is no design param (e.g., `nodeType`, `instanceClass`, `multiAz`, `zones`, `environment`).
- `uses` and `members`: addresses of folded resources read by this rule (`uses` populates `folded[].into`, and `members` redirects incoming/outgoing graph lines to this node—see `rdsCluster` and `proxyFor` in `src/import/terraform/rules-platform.ts`).
- `entry: true`: marks an internet-facing entry point (`loadBalancer`, `cloudfront`, `route53Record`, `gateway`).
- `front`: places a `rate_limiter` node in front of the node (`gateway` and `dynamoTable` in `src/import/terraform/rules-serverless.ts`).
- `edgeParams` / `lineWeights` / `sourceCap`: overrides on outgoing edges or inbound event-source caps (`gateway`, `route53Record`, `lambdaFunction`).
- `notes`: approximation and warning message ids (`import.approx.*`, `import.unknownValue`), defined in `src/i18n/importMessages.ts` (`MESSAGES`).

Helpers in `src/import/terraform/rule-kit.ts` handle nested blocks (`block()`), safe numeric reads (`num()`), reverse references (`referrers()`), subnet AZs (`zonesOf()`), and attributes written in HCL whose values are unknown until apply or marked sensitive (`configured()`, `unknownSet()`).

### 3. Update Grouping and Graph Lines if Needed (`src/import/terraform/graph.ts`)

- **Traffic lines**: Check whether `definiteLines()`, `presumedLines()`, or security-group `candidate` lines in `src/import/terraform/graph.ts` already connect the new resource. Add a branch in `definiteLines()` if Terraform wires callers to the resource through an explicit attribute (like `aws_lambda_event_source_mapping` or `aws_lb_listener`).
- **Instance grouping**: `groupInstances()` merges identical `count`/`for_each` instances into one node. Add differentiating attributes to `ROLE_KEYS` (or forbid merging in `NO_MERGE`), and register folded child links in `MEMBER_OF`.
- **Instance table assumptions**: If the resource has an instance type or size that maps to `serviceMs`, `concurrency`, `readMs`, `writeMs`, `opMs`, or `max_connections`, wire its fact into `fillFromTable()` in `src/import/terraform/fill.ts` and `ASSUME` / `sizeOf()` in `src/import/terraform/instances.ts`.

### 4. Tag Every Origin and Source (`defaults.ts`, `rule-kit.ts`, `checks.ts`)

Every value in `params`, `facts`, and `edgeParams` must carry an `Origin`. `tests/import/rules.test.ts` and `tests/import/rules-ecs.test.ts` enforce that every param has an origin and every default/estimate names its source; `certaintyOf()` in `src/import/terraform/checks.ts` uses those origins to decide whether `--strict` should block:

- **IaC (`iac(r, attr)`)**: explicit value in the plan (`evidence: 'iac'`). Counts as `definite`.
- **Provider / AWS default (`awsDefault(r, attr, source)`)**: documented provider or AWS default (`evidence: 'aws-default'`). Store the value and pinned `https://` documentation URL in `DEFAULTS` in `src/import/terraform/defaults.ts` (using `PROVIDER_DOCS` when quoting the Terraform AWS provider docs). Counts as `definite`.
- **Configured vs. default vs. unknown (`setOr(r, attr, source)`)**: picks `'estimate'` with `unknown: 'apply' | 'sensitive'` when written in config but absent from the plan, `'iac'` when known, and `'aws-default'` when omitted. For safety-critical booleans or timeouts where assuming a default would hide a problem (such as `multi_az` in `dbInstance` or `timeout` in `lambdaFunction`), check `unknownSet()` first and emit a note instead of filling a default.
- **Our estimate (`estimate(from, source)`)**: modeling approximations or soft quotas that can be raised (such as `ASSUME` in `src/import/terraform/instances.ts`, `accountConcurrency` in `lambdaFunction`, or `readFrom` in `dbInstance`). Every `estimate` must set a non-empty `source` string (pointing to the file/constant or explanation) and downgrades any check using it from `definite` to `assumption` so `--strict` does not fail on guesses.

### 5. Add Static Checks (`src/import/terraform/checks.ts`)

If the resource introduces capacity or reliability failure modes (such as single-AZ deployment, connection limits, or timeout ordering), add a check in `runChecks()` in `src/import/terraform/checks.ts` using `param()`, `fact()`, and `add()`. Call `incomplete()` whenever a required input is missing instead of assuming a safe value. Add any new `check.*` message ids to `src/i18n/importMessages.ts`.

### 6. Add Tests and Fixtures (`tests/import/`)

1. **Synthetic unit tests**: Use `plan()` and `refs()` from `tests/import/plan-helper.ts` to add targeted cases in `tests/import/rules.test.ts` (or `tests/import/rules-ecs.test.ts`) and `tests/import/checks.test.ts`. Assert node kinds, `params`, `origins`, `facts`, `notes`, `folded`, `unmapped`, `parseDesign(r.design).ok`, and `runChecks()`.
2. **Real plan fixtures**: Saved plans live in `tests/import/fixtures/` (for example `tests/import/fixtures/ecs-rds.plan.json`, `tests/import/fixtures/lambda-sqs-rds.plan.json`, and `tests/import/fixtures/aurora-cache-multiaz.plan.json`, each paired with `<name>/main.tf` and `<name>.expected.json`). If you add a new fixture directory, add it to `SETS` in `scripts/gen-fixtures.sh` and `tests/import/fixtures.test.ts`, and add its assertions to `tests/import/rules.test.ts`.
   - Never run `terraform apply`. `scripts/gen-fixtures.sh` runs `terraform plan` and `terraform show -json` offline inside `sandbox-exec` and strips fake secrets with `scripts/scrub-plan.ts`:

```sh
scripts/gen-fixtures.sh --init   # once, with network: downloads the provider into .terraform
scripts/gen-fixtures.sh          # offline: plans inside sandbox-exec and scrubs secrets
```

### 7. Commands to Run

```sh
npm run test:quick
npx vitest run tests/import/rules.test.ts tests/import/checks.test.ts tests/import/fixtures.test.ts
npm run typecheck
node scripts/i18n-extract.ts      # extract new Traditional Chinese message ids into src/i18n/en.ts
npm run i18n:check                # verify 0 missing English translations
npm run loadsketch -- import terraform tests/import/fixtures/ecs-rds.plan.json --out /tmp/design.json --report /tmp/report.md
```

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>

[optional body]

[optional footer]
```

### Types

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `refactor:` - Code refactoring (no behavior change)
- `perf:` - Performance improvements
- `test:` - Adding or updating tests
- `chore:` - Build process, dependencies, tooling

### Examples

```
feat: add a rate limiter example with per-tenant quotas

fix: count a retry that commits twice on one replica as one copy

docs: explain how the scale factor changes long runs

refactor: move the breaker state into its own function
```

## Pull Request Process

### Before Submitting

- [ ] `npm run test:quick` passes
- [ ] `npm run typecheck` passes
- [ ] For engine changes: the golden test passes, or the hashes are updated with a reason
- [ ] For UI changes: `npx playwright test` passes
- [ ] Commit messages follow convention
- [ ] Branch is up to date with `main`

```bash
# Update your branch with latest main
git fetch upstream
git rebase upstream/main
```

### PR Description

Include:
- **What** - What does this PR do?
- **Why** - Why is this change needed?
- **How** - How did you implement it?
- **Testing** - How did you test it?
- **Screenshots** - If UI changes, include before/after screenshots in light and dark themes

### Review Process

1. Maintainer will review your PR
2. Address any requested changes
3. Once approved, maintainer will merge your PR
4. Your change goes live on the site with the next deploy

### After Merge

Your branch will be automatically deleted. You can safely delete your local branch:

```bash
git checkout main
git branch -d feature/your-feature-name
```

## Getting Help

- Open an issue for bugs or feature requests
- Ask questions in PR comments
- Check existing issues and PRs for similar discussions

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
