# Contributing to loadsketch

Thanks for your interest in contributing to loadsketch! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How to Contribute](#how-to-contribute)
- [Development Setup](#development-setup)
- [Contribution Workflow](#contribution-workflow)
- [Coding Standards](#coding-standards)
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

If the simulation gives a result you think is wrong, say what you expected and why (a formula, a paper, or how the real system behaves).

### Suggesting Features

Feature requests are welcome! Please:
- Check if the feature has already been requested
- Explain the use case and why it would be valuable
- Provide examples of how it would work

### Contributing Code

We welcome code contributions! Areas where we especially need help:
- **Examples**: new designs and scenarios that teach one idea well
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
│   ├── learn/              # Lessons, on-call incidents, cost, diagnosis
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
