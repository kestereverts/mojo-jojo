# RxJS Operators Quick Reference

## Transformation Operators

| Operator | Description | When to Use |
|----------|-------------|-------------|
| `map` | Transform each value | Simple value transformation |
| `switchMap` | Switch to new stream | HTTP requests, search |
| `mergeMap` | Flatten all | Parallel requests |
| `concatMap` | Sequential flatten | Order matters |
| `exhaustMap` | Ignore while busy | Button clicks |

## Filtering Operators

| Operator | Description | When to Use |
|----------|-------------|-------------|
| `filter` | Pass matching values | Conditional logic |
| `take(n)` | Take first n values | Limited emissions |
| `takeUntil` | Complete on signal | Cleanup subscriptions |
| `first` | First value only | Single emission |
| `debounceTime` | Wait for pause | Search input |
| `distinctUntilChanged` | Skip duplicates | Prevent redundant |

## Memory Leak Prevention Pattern

```typescript
private destroy$ = new Subject<void>();

ngOnInit() {
  this.data$.pipe(
    takeUntil(this.destroy$)
  ).subscribe();
}

ngOnDestroy() {
  this.destroy$.next();
  this.destroy$.complete();
}
```
