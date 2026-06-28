#!/bin/bash
# Check for potential subscription leaks in Angular project

echo "Checking for subscription leaks..."

# Find .subscribe() without takeUntil
echo ""
echo "=== Potential Leaks (subscribe without takeUntil) ==="
grep -rn "\.subscribe(" --include="*.ts" | grep -v "takeUntil" | grep -v "\.spec\.ts" | head -20

# Find missing ngOnDestroy
echo ""
echo "=== Components without ngOnDestroy ==="
for file in $(find . -name "*.component.ts" -type f); do
    if grep -q "subscribe(" "$file" && ! grep -q "ngOnDestroy" "$file"; then
        echo "$file"
    fi
done

echo ""
echo "Scan complete. Review findings above."
