# Theme Development Guide

> This document is the complete reference for Typecho-CF theme development. `typecho-theme-minimal/` serves as the working example.

[中文](README.md)

---

## Directory Structure

```
typecho-theme-example/
├── package.json        # npm package manifest (keywords must include typecho + theme)
├── theme.json          # Optional metadata (or use package.json typecho.theme)
├── style.css           # Main stylesheet
└── components/         # Optional: custom template components
    ├── Index.astro     # Home page (post list)
    ├── Post.astro      # Post detail
    ├── Page.astro      # Independent page
    ├── Archive.astro   # Archive (category/tag/author/search)
    └── NotFound.astro  # 404 page
```

Themes without a `components/` directory are CSS-only themes — the system automatically falls back to the default theme's template components.

---

## package.json

```json
{
  "name": "typecho-theme-example",
  "version": "1.0.0",
  "description": "Theme description",
  "author": "Your Name",
  "license": "MIT",
  "keywords": ["typecho", "theme"],
  "files": [
    "theme.json",
    "style.css",
    "components/"
  ]
}
```

**Key constraints**:
- `keywords` must include both `"typecho"` and `"theme"` — otherwise the build-time scanner won't discover it
- `files` declares what to publish (can be omitted for local development)

---

## theme.json

```json
{
  "id": "typecho-theme-example",
  "name": "Example Theme",
  "description": "Theme description",
  "author": "Your Name",
  "authorUrl": "https://example.com",
  "version": "1.0.0",
  "homepage": "https://github.com/...",
  "license": "MIT",
  "stylesheet": "style.css",
  "stylesheets": ["normalize.css", "grid.css"]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | No | Unique identifier; defaults to the npm package name |
| `name` | No | Display name; defaults to the npm package name |
| `stylesheet` | No | Main CSS source filename, default `style.css`; emitted as `public/themes/{id}/style.css` |
| `stylesheets` | No | Additional CSS files (loaded in order, before `stylesheet`) |

> **Config priority**: `theme.json` > `package.json` `typecho.theme` field > values inferred from `package.json`. The main CSS file must exist in every case.

---

## Template Component Props

All template component Props types are defined in the main project at `src/lib/theme-props.ts`.

### Base Props (ThemeBaseProps — included in all components)

```typescript
interface ThemeBaseProps {
  options: SiteOptions;          // Site config (title, description, timezone, etc.)
  urls: {                        // Computed URL set
    siteUrl: string;
    adminUrl: string;
    loginUrl: string;
    logoutUrl: string;
    profileUrl: string;
    feedUrl: string;
    commentsFeedUrl: string;
  };
  user: UserRow | null;          // Currently logged-in user (null = anonymous)
  isLoggedIn: boolean;
  pages: Array<{                 // Navigation pages (published independent pages)
    title: string;
    slug: string;
    permalink: string;
  }>;
  sidebarData: SidebarData;      // Sidebar widget data (categories, tags, recent posts, etc.)
  currentPath: string;           // Current request path
  pluginCtx: HookContext;        // Active plugins for display hooks executed by the Base layout
}
```

### Index.astro (ThemeIndexProps)

```typescript
interface ThemeIndexProps extends ThemeBaseProps {
  posts: PostListItem[];         // Post list
  pagination: PaginationInfo;    // Pagination info (currentPage, totalPages, hasPrev, hasNext)
}
```

### Post.astro (ThemePostProps)

```typescript
interface ThemePostProps extends ThemeBaseProps {
  post: {
    cid: number;
    title: string;
    permalink: string;
    content: string;             // Rendered HTML (processed through Hook filters)
    created: number;             // Unix timestamp (seconds)
    modified: number | null;
    commentsNum: number;
    allowComment: boolean;
    hasPassword: boolean;        // Whether the post is password-protected
    passwordVerified: boolean;   // Whether the visitor supplied the correct password
  };
  author: { uid: number; name: string; screenName: string } | null;
  categories: Array<{ name: string; slug: string; permalink: string }>;
  tags: Array<{ name: string; slug: string; permalink: string }>;
  comments: CommentNode[];
  commentPagination: CommentPagination;
  commentOptions: CommentOptions;
  prevPost: { title: string; permalink: string } | null;
  nextPost: { title: string; permalink: string } | null;
  gravatarMap: Record<number, string>;  // coid → Gravatar URL
}
```

### Page.astro (ThemePageProps)

```typescript
interface ThemePageProps extends ThemeBaseProps {
  page: {
    cid: number;
    title: string;
    slug: string;
    permalink: string;
    content: string;             // Rendered HTML
    created: number;
    allowComment: boolean;
    hasPassword: boolean;
    passwordVerified: boolean;
  };
  comments: CommentNode[];
  commentPagination: CommentPagination;
  commentOptions: CommentOptions;
  gravatarMap: Record<number, string>;
}
```

### Archive.astro (ThemeArchiveProps)

```typescript
interface ThemeArchiveProps extends ThemeBaseProps {
  archiveTitle: string;          // e.g. "Posts in category: Technology"
  archiveType: 'category' | 'tag' | 'author' | 'search' | 'index';
  posts: PostListItem[];
  pagination: PaginationInfo;
}
```

### NotFound.astro (ThemeNotFoundProps)

```typescript
interface ThemeNotFoundProps extends ThemeBaseProps {
  statusCode: number;            // 404
  errorTitle: string;
}
```

### Shared Sub-types

```typescript
interface PostListItem {
  cid: number;
  title: string;
  permalink: string;
  excerpt: string;               // Rendered HTML excerpt (<!--more--> supported)
  created: number;
  commentsNum: number;
  author: { uid: number; name: string; screenName: string } | null;
  categories: Array<{ name: string; slug: string; permalink: string }>;
}

interface CommentNode {
  coid: number;
  author: string;
  mail: string;
  url: string;
  text: string;                  // Rendered HTML
  created: number;
  children: CommentNode[];       // Nested replies
}

interface CommentPagination {
  enabled: boolean;
  currentPage: number;
  totalPages: number;
  totalComments: number;
  pageSize: number;
  pages: number[];
  pageUrls: Record<number, string>;
  prevUrl: string | null;
  nextUrl: string | null;
}
```

---

## Astro Component Example

```astro
---
// components/Index.astro
import Base from '@/layouts/Base.astro';
import type { ThemeIndexProps } from '@/lib/theme-props';

type Props = ThemeIndexProps;

const { options, posts, pagination, urls, isLoggedIn, user, pluginCtx } = Astro.props;
---
<Base options={options} urls={urls} user={user} isLoggedIn={isLoggedIn} pluginCtx={pluginCtx}>
  <header>
    <a href={urls.siteUrl}>{options.title}</a>
  </header>

  <main>
    {posts.map(post => (
      <article>
        <h2><a href={post.permalink}>{post.title}</a></h2>
        <Fragment set:html={post.excerpt} />
      </article>
    ))}
  </main>

  {pagination.hasNext && (
    <a href={`/?page=${pagination.currentPage + 1}`}>Next Page</a>
  )}
</Base>
```

> Follow the default theme and use the system `Base.astro` with `pluginCtx` unless you intentionally provide your own document shell. `Base` supplies the HTML document, theme stylesheets, feed discovery, and `archive:header` / `archive:footer` plugin injection. The runtime selects components through a build-time virtual module but does not automatically wrap them in a layout.

---

## Stylesheet Loading

The system `Base.astro` injects the following `<link>` tags into `<head>` (based on the theme manifest):

```html
<!-- stylesheets list (in order) -->
<link rel="stylesheet" href="/themes/typecho-theme-example/normalize.css">
<link rel="stylesheet" href="/themes/typecho-theme-example/grid.css">
<!-- main stylesheet -->
<link rel="stylesheet" href="/themes/typecho-theme-example/style.css">
```

> Themes using `Base.astro` do not need to link stylesheets themselves. Themes that emit a standalone HTML document must handle them explicitly.

---

## Installing into the Project

### Local development (workspace package)

1. Place the theme directory under `src/themes/`
2. Add `"<packageName>": "file:src/themes/<packageName>"` to the root `package.json` `dependencies`
3. Run `pnpm install`
4. Rebuild with `pnpm run build`
5. Switch to the new theme in the admin panel under "Appearance"

### Install from npm

```bash
pnpm add typecho-theme-example
pnpm run build
```

---

## Reference Example

`typecho-theme-minimal/` demonstrates:
- `theme.json` with multiple stylesheets (`normalize.css` + `grid.css` + `style.css`)
- All 5 template components including a nested comment list (`CommentList.astro`)
- Full use of `ThemePostProps` (password protection, nested comment replies, prev/next navigation)
- `sidebarData` rendering (recent posts, recent comments, categories, archives)
- Plugin client-side code integration (`getClientSnippet`)
