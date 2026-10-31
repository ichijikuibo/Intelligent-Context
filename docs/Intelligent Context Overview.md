# Intelligent Context Overview

## What It Is

Intelligent Context is a context layer that sits between an AI coding tool and the model it calls. Its purpose is simple: help the model build and keep useful product knowledge over time without forcing every request to carry the full cost of a large codebase.

Instead of starting cold on every prompt, the system learns from previous requests, stores what matters about the project, and sends only the most relevant knowledge into the next request. The result is a coding assistant that becomes more informed as it is used.

## Why It Exists

Current AI coding tools are powerful, but they struggle with large or long-running projects for three reasons:

1. They often begin each task by rediscovering the codebase.
2. They consume large numbers of input tokens when broad context is added.
3. They do not naturally build lasting, project-specific understanding.

That creates a poor tradeoff. To get better answers, teams send more context. Sending more context increases cost and can still leave the model without the exact knowledge it needs. In practice, this means slower progress, more repeated explanation from developers, and inconsistent understanding across requests.

Intelligent Context is designed to solve that problem by giving the model a growing, project-sensitive memory and a way to select the right parts of it for each task.

## How It Works

At a high level, the product works in four steps:

1. A developer sends a normal request from their IDE.
2. Intelligent Context selects the most relevant stored knowledge for that request and injects it before the model sees the prompt.
3. The request is forwarded to the chosen AI provider.
4. After the response, the system extracts new project learnings, stores them, and improves future requests.

Over time, this builds a reusable knowledge base about the project: architecture decisions, conventions, known constraints, recurring patterns, and product-specific behavior.

## Expected Benefits

### Quicker Responses

The model starts with a better idea of where to look and what matters. That reduces the time spent on broad discovery and lowers the amount of back-and-forth needed before it can do useful work. In practical terms, the assistant should spend less time searching and more time solving.

### Lower Input Token Use

Large projects can become expensive because broad context has to be re-sent repeatedly. Intelligent Context changes that by storing knowledge once, compressing it over time, and injecting only the relevant parts for each new request.

The extra cost of learning and maintaining this context should be materially smaller than the ongoing cost of repeatedly sending large amounts of raw project context. On bigger codebases, that difference is expected to become more valuable over time.

### Better Product Knowledge

The goal is to build a working context comparable to the mental model of a senior developer who has spent time with the product. Rather than relying on a single oversized prompt, the system accumulates understanding gradually and reuses it intelligently.

That means the assistant can become better at:

- understanding architecture and design patterns
- remembering project conventions and preferences
- recognizing known constraints and edge cases
- responding with more consistency across separate tasks

Only the relevant parts of that knowledge are sent with each request, which preserves the benefit without forcing the full accumulated history into every prompt.

## Why This Matters Commercially

For individual developers, the value is improved coding assistance that becomes more useful over time.

For teams, the value is consistency. Instead of every developer repeatedly teaching the model the same project details, those details can be learned once and reused. That can reduce duplicated effort, improve onboarding, and make AI-assisted development more dependable in real projects rather than only in small or short-lived tasks.

This positions Intelligent Context as a practical productivity layer, not just another model wrapper. Its value comes from improving the quality and efficiency of how existing models are used.

## Product Packages

The current plan is to offer two packages:

### Local Package

The local package is designed for individual developers or organizations that want everything to stay on one machine or within a tightly controlled local setup.

- Runs locally
- Stores context locally
- Suitable for private development environments
- Best fit for solo users, consultants, and security-sensitive workflows

### Shared Package

The shared package is designed for teams that want a common project context available across multiple developers.

- Shared context across a team or hosted environment
- Better for collaboration and onboarding
- Allows project knowledge to accumulate at the team level rather than the individual level
- Best fit for internal engineering teams and self-hosted group deployments

Both packages are currently planned as single-purchase offerings.

## Future Direction

While the immediate plan is to sell local and shared versions as one-time purchases, the architecture also supports a future all-inclusive SaaS product.

That future version could provide:

- managed hosting
- simpler setup for teams
- centralized updates and monitoring
- broader collaboration features
- usage-based or subscription pricing if the market supports it

The current packaging keeps adoption simple, while leaving room for a fully managed commercial model later.

## Summary

Intelligent Context is built around a straightforward idea: AI coding tools become more valuable when they can learn a project over time and use that knowledge selectively.

The reason behind the product is to remove the repeated cost of rediscovery. The expected result is quicker responses, lower input token use, and better long-term product knowledge. In short, it aims to make AI assistance feel less like a stateless chat tool and more like working with someone who already understands the codebase.