"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/cn";

type Key = string | number;

type VirtualListProps<T> = {
  readonly items: readonly T[];
  readonly estimateSize: number | ((item: T, index: number) => number);
  readonly getKey: (item: T, index: number) => Key;
  readonly renderItem: (item: T, index: number) => ReactNode;
  readonly className?: string;
  readonly itemClassName?: string;
  readonly overscan?: number;
  readonly gap?: number;
  readonly initialScroll?: "start" | "end";
  readonly initialIndex?: number;
  readonly onEndReached?: () => void;
  readonly endReachedThreshold?: number;
};

type WindowRange = {
  readonly start: number;
  readonly end: number;
};

function rangeFor(scrollTop: number, viewportHeight: number, offsets: readonly number[], sizes: readonly number[], overscan: number): WindowRange {
  const visibleTop = Math.max(0, scrollTop);
  const visibleBottom = visibleTop + Math.max(0, viewportHeight);
  let start = 0;
  while (start < offsets.length && offsets[start] + sizes[start] < visibleTop) start += 1;
  let end = start;
  while (end < offsets.length && offsets[end] < visibleBottom) end += 1;
  return {
    start: Math.max(0, start - overscan),
    end: Math.min(offsets.length, end + overscan),
  };
}

function VirtualRow({
  children,
  className,
  onMeasure,
  style,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly onMeasure: (height: number) => void;
  readonly style: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => onMeasure(node.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [onMeasure]);

  return (
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}

export function VirtualList<T>({
  items,
  estimateSize,
  getKey,
  renderItem,
  className,
  itemClassName,
  overscan = 8,
  gap = 0,
  initialScroll = "start",
  initialIndex,
  onEndReached,
  endReachedThreshold = 320,
}: VirtualListProps<T>) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const measuredSizesRef = useRef(new Map<Key, number>());
  const lastEndReachedRef = useRef("");
  const appliedInitialIndexRef = useRef("");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [measureVersion, setMeasureVersion] = useState(0);
  const keys = useMemo(() => items.map((item, index) => getKey(item, index)), [getKey, items]);
  const keySignature = keys.join("\u001f");

  const sizes = useMemo(
    () =>
      keys.map((key, index) =>
        measuredSizesRef.current.get(key)
          ?? (typeof estimateSize === "function" ? estimateSize(items[index], index) : estimateSize),
      ),
    [estimateSize, items, keys, measureVersion],
  );
  const offsets = useMemo(() => {
    let nextOffset = 0;
    return sizes.map((size, index) => {
      const current = nextOffset;
      nextOffset += size + (index < sizes.length - 1 ? gap : 0);
      return current;
    });
  }, [gap, sizes]);
  const totalSize = sizes.reduce((total, size) => total + size, 0) + Math.max(0, sizes.length - 1) * gap;
  const windowRange = rangeFor(scrollTop, viewportHeight, offsets, sizes, overscan);
  const visibleItems = items.slice(windowRange.start, windowRange.end);

  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const syncViewportHeight = () => setViewportHeight(node.clientHeight);
    syncViewportHeight();
    const observer = new ResizeObserver(syncViewportHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (typeof initialIndex !== "number" || initialIndex < 0 || items.length === 0) return;
    const node = viewportRef.current;
    if (!node) return;
    const index = Math.min(items.length - 1, Math.trunc(initialIndex));
    const signature = `${keySignature}:${index}`;
    if (appliedInitialIndexRef.current === signature) return;
    appliedInitialIndexRef.current = signature;
    node.scrollTop = Math.max(0, offsets[index] ?? 0);
    setScrollTop(node.scrollTop);
  }, [initialIndex, items.length, keySignature, offsets]);

  useLayoutEffect(() => {
    if (typeof initialIndex === "number" && initialIndex >= 0) return;
    if (initialScroll !== "end") return;
    const node = viewportRef.current;
    if (!node) return;
    node.scrollTop = Math.max(0, totalSize - node.clientHeight);
    setScrollTop(node.scrollTop);
  }, [initialIndex, initialScroll, keySignature, totalSize]);

  const measure = useCallback((key: Key, height: number) => {
    const current = measuredSizesRef.current.get(key);
    if (Math.abs((current ?? 0) - height) < 1) return;
    measuredSizesRef.current.set(key, height);
    setMeasureVersion((version) => version + 1);
  }, []);

  const maybeCallEndReached = useCallback((node: HTMLDivElement) => {
    if (!onEndReached || items.length === 0) return;
    const remaining = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (remaining > endReachedThreshold) return;
    const signature = `${items.length}:${Math.round(node.scrollHeight)}`;
    if (lastEndReachedRef.current === signature) return;
    lastEndReachedRef.current = signature;
    onEndReached();
  }, [endReachedThreshold, items.length, onEndReached]);

  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    maybeCallEndReached(node);
  }, [maybeCallEndReached, totalSize, viewportHeight]);

  return (
    <div
      ref={viewportRef}
      className={cn("scroll-quiet min-h-0 overflow-y-auto", className)}
      onScroll={(event) => {
        setScrollTop(event.currentTarget.scrollTop);
        maybeCallEndReached(event.currentTarget);
      }}
    >
      <div className="relative w-full" style={{ height: totalSize }}>
        {visibleItems.map((item, visibleIndex) => {
          const index = windowRange.start + visibleIndex;
          const key = keys[index] ?? getKey(item, index);
          const top = offsets[index] ?? 0;
          return (
            <VirtualRow
              key={key}
              className={itemClassName}
              onMeasure={(height) => measure(key, height)}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top,
              }}
            >
              {renderItem(item, index)}
            </VirtualRow>
          );
        })}
      </div>
    </div>
  );
}
