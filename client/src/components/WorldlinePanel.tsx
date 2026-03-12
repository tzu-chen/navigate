import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import * as d3 from 'd3';
import Markdown from 'react-markdown';
import { SavedPaper, Worldline, ChatMessage, WorldlineChatSession } from '../types';
import * as api from '../services/api';
import LaTeX from './LaTeX';

interface Props {
  papers: SavedPaper[];
  showNotification: (msg: string) => void;
  onRefresh: () => Promise<void>;
  onOpenPaper: (paper: SavedPaper) => void;
}

interface WorldlineWithPapers extends Worldline {
  paperIds: Set<number>;
}

export default function WorldlinePanel({ papers, showNotification, onRefresh, onOpenPaper }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [worldlines, setWorldlines] = useState<WorldlineWithPapers[]>([]);
  const [selectedPaperIds, setSelectedPaperIds] = useState<Set<number>>(new Set());
  const [hoveredPaperId, setHoveredPaperId] = useState<number | null>(null);
  const [activeWorldlineId, setActiveWorldlineId] = useState<number | null>(null);

  // Ref for click/dblclick disambiguation (delay click so dblclick can cancel it)
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onOpenPaperRef = useRef(onOpenPaper);
  onOpenPaperRef.current = onOpenPaper;

  // Worldline creation form
  const [newWlName, setNewWlName] = useState('');
  const [newWlColor, setNewWlColor] = useState('#6366f1');

  // Sidebar collapse — default closed on mobile
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 768);

  // Visibility toggles (persisted to localStorage)
  const [showWorldlines, setShowWorldlines] = useState<boolean>(() => {
    try { const s = localStorage.getItem('paperpile-worldline-visibility'); if (s) { const v = JSON.parse(s); return v.showWorldlines ?? true; } } catch {} return true;
  });
  const [showNonWorldlinePapers, setShowNonWorldlinePapers] = useState<boolean>(() => {
    try { const s = localStorage.getItem('paperpile-worldline-visibility'); if (s) { const v = JSON.parse(s); return v.showNonWorldlinePapers ?? true; } } catch {} return true;
  });

  // Persist visibility toggles
  useEffect(() => {
    localStorage.setItem('paperpile-worldline-visibility', JSON.stringify({ showWorldlines, showNonWorldlinePapers }));
  }, [showWorldlines, showNonWorldlinePapers]);

  // Worldline chat
  const [wlChatOpen, setWlChatOpen] = useState(false);
  const [wlChatMessages, setWlChatMessages] = useState<ChatMessage[]>([]);
  const [wlChatInput, setWlChatInput] = useState('');
  const [wlChatLoading, setWlChatLoading] = useState(false);
  const [wlChatSessionId, setWlChatSessionId] = useState<string | null>(null);
  const [wlChatSessions, setWlChatSessions] = useState<WorldlineChatSession[]>([]);
  const [wlChatShowHistory, setWlChatShowHistory] = useState(false);
  const wlChatEndRef = useRef<HTMLDivElement>(null);

  // Collapsible sections
  const [allPapersOpen, setAllPapersOpen] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const wls = await api.getWorldlines();

      // Load paper IDs for each worldline
      const wlsWithPapers: WorldlineWithPapers[] = await Promise.all(
        wls.map(async (wl) => {
          const wlPapers = await api.getWorldlinePapers(wl.id);
          return { ...wl, paperIds: new Set(wlPapers.map((p: SavedPaper) => p.id)) };
        })
      );
      setWorldlines(wlsWithPapers);
    } catch (err) {
      console.error('Failed to load worldline data:', err);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Compute paper positions: x is spread by category, y is time
  const paperPositions = useMemo(() => {
    if (papers.length === 0) return new Map<number, { x: number; y: number }>();

    // Parse dates and find time range
    const parsedPapers = papers.map(p => ({
      ...p,
      date: new Date(p.published),
      cats: (() => { try { return JSON.parse(p.categories); } catch { return []; } })() as string[],
    }));

    // Group by primary category for x-spread
    const catGroups = new Map<string, number[]>();
    parsedPapers.forEach(p => {
      const primaryCat = p.cats[0] || 'unknown';
      if (!catGroups.has(primaryCat)) catGroups.set(primaryCat, []);
      catGroups.get(primaryCat)!.push(p.id);
    });

    const catKeys = Array.from(catGroups.keys()).sort();
    const catXMap = new Map<string, number>();
    catKeys.forEach((cat, i) => {
      catXMap.set(cat, (i + 1) / (catKeys.length + 1));
    });

    const positions = new Map<number, { x: number; y: number }>();
    // Track occupancy within each category for sub-spreading
    const catCounters = new Map<string, number>();

    parsedPapers.forEach(p => {
      const primaryCat = p.cats[0] || 'unknown';
      const baseX = catXMap.get(primaryCat) || 0.5;
      const count = catCounters.get(primaryCat) || 0;
      catCounters.set(primaryCat, count + 1);

      // Add small horizontal jitter based on count within category
      const groupSize = catGroups.get(primaryCat)?.length || 1;
      const jitter = groupSize > 1 ? ((count / (groupSize - 1)) - 0.5) * 0.06 : 0;

      positions.set(p.id, {
        x: baseX + jitter,
        y: p.date.getTime(),
      });
    });

    return positions;
  }, [papers]);

  // Get active worldline
  const activeWorldline = worldlines.find(w => w.id === activeWorldlineId) || null;

  // Track tooltip position in page coordinates
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  // D3 rendering — builds the full SVG. Does NOT depend on hoveredPaperId
  // so hovering never causes a full re-render.
  useEffect(() => {
    if (!svgRef.current || !containerRef.current || papers.length === 0) return;

    const svg = d3.select(svgRef.current);
    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    svg.attr('width', width).attr('height', height);

    // Clear previous content
    svg.selectAll('*').remove();

    const margin = { top: 40, right: 30, bottom: 40, left: 80 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    // Scales
    const dates = papers.map(p => new Date(p.published));
    const minDate = d3.min(dates)!;
    const maxDate = d3.max(dates)!;
    // Add padding to date range
    const dateRange = maxDate.getTime() - minDate.getTime();
    const datePadding = dateRange * 0.05 || 86400000; // 1 day if all same date

    const yScale = d3.scaleTime()
      .domain([new Date(minDate.getTime() - datePadding), new Date(maxDate.getTime() + datePadding)])
      .range([innerH, 0]);

    const xScale = d3.scaleLinear()
      .domain([0, 1])
      .range([0, innerW]);

    // Create main group with zoom
    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Clip path
    svg.append('defs').append('clipPath')
      .attr('id', 'chart-clip')
      .append('rect')
      .attr('width', innerW)
      .attr('height', innerH);

    const chartArea = g.append('g').attr('clip-path', 'url(#chart-clip)');

    // Zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 10])
      .on('zoom', (event) => {
        chartArea.attr('transform', event.transform.toString());
        // Update axes
        const newYScale = event.transform.rescaleY(yScale);
        const newXScale = event.transform.rescaleX(xScale);
        yAxisG.call(d3.axisLeft(newYScale).ticks(8));
        xAxisG.call(d3.axisBottom(newXScale).ticks(0)); // hide x ticks

        // Update category labels dynamically
        g.selectAll('.category-labels .cat-label')
          .each(function (_d: unknown, i: number) {
            if (i < catPositions.length) {
              d3.select(this).attr('x', newXScale(catPositions[i].x));
            }
          });

        // Update separator lines dynamically
        g.selectAll('.category-separators .cat-separator')
          .each(function (_d: unknown, i: number) {
            if (i < separatorXValues.length) {
              d3.select(this)
                .attr('x1', newXScale(separatorXValues[i]))
                .attr('x2', newXScale(separatorXValues[i]));
            }
          });

        // Update shaded bands dynamically
        let bandIdx = 0;
        g.selectAll('.category-separators .cat-band')
          .each(function () {
            // Find the matching catPositions index for this band
            while (bandIdx < catPositions.length && bandIdx % 2 !== 0) bandIdx++;
            if (bandIdx >= catPositions.length) return;
            const leftBound = bandIdx === 0 ? 0 : separatorXValues[bandIdx - 1];
            const rightBound = bandIdx === catPositions.length - 1 ? 1 : separatorXValues[bandIdx];
            d3.select(this)
              .attr('x', newXScale(leftBound))
              .attr('width', newXScale(rightBound) - newXScale(leftBound));
            bandIdx += 2;
          });

        // Re-style axes after zoom
        svg.selectAll('.wl-axis text')
          .attr('fill', 'var(--text-muted)')
          .attr('font-size', '11px');
        svg.selectAll('.wl-axis line, .wl-axis path')
          .attr('stroke', 'var(--border-color)');
      });

    svg.call(zoom);

    // Click on empty space: clear selection and deactivate worldline
    svg.on('click', () => {
      setSelectedPaperIds(new Set());
      setActiveWorldlineId(null);
    });

    // Axes
    const yAxisG = g.append('g')
      .call(d3.axisLeft(yScale).ticks(8))
      .attr('class', 'wl-axis');

    const xAxisG = g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(xScale).ticks(0))
      .attr('class', 'wl-axis');

    // Collect category x-positions (sorted)
    const catPositions: { cat: string; x: number }[] = [];
    const catSeen = new Set<string>();
    papers.forEach(p => {
      try {
        const cats = JSON.parse(p.categories) as string[];
        const cat = cats[0] || 'unknown';
        if (!catSeen.has(cat)) {
          catSeen.add(cat);
          const pos = paperPositions.get(p.id);
          if (pos) catPositions.push({ cat, x: pos.x });
        }
      } catch {}
    });
    catPositions.sort((a, b) => a.x - b.x);

    // Compute separator boundaries (midpoints between adjacent categories)
    const separatorXValues: number[] = [];
    for (let i = 0; i < catPositions.length - 1; i++) {
      separatorXValues.push((catPositions[i].x + catPositions[i + 1].x) / 2);
    }

    // Group for separators and labels (outside chartArea, inside g, so not clipped)
    const separatorGroup = g.insert('g', ':first-child').attr('class', 'category-separators');

    // Draw alternating shaded bands
    catPositions.forEach((cp, i) => {
      const leftBound = i === 0 ? 0 : separatorXValues[i - 1];
      const rightBound = i === catPositions.length - 1 ? 1 : separatorXValues[i];
      if (i % 2 === 0) {
        separatorGroup.append('rect')
          .attr('class', 'cat-band')
          .attr('x', xScale(leftBound))
          .attr('y', 0)
          .attr('width', xScale(rightBound) - xScale(leftBound))
          .attr('height', innerH)
          .attr('fill', 'var(--text-muted)')
          .attr('opacity', 0.04);
      }
    });

    // Draw separator lines between categories
    separatorXValues.forEach(sx => {
      separatorGroup.append('line')
        .attr('class', 'cat-separator')
        .attr('x1', xScale(sx))
        .attr('y1', 0)
        .attr('x2', xScale(sx))
        .attr('y2', innerH)
        .attr('stroke', 'var(--text-muted)')
        .attr('stroke-width', 1)
        .attr('stroke-opacity', 0.15)
        .attr('stroke-dasharray', '4,4');
    });

    // Category labels at the top (dynamic with zoom)
    const labelGroup = g.append('g').attr('class', 'category-labels');
    catPositions.forEach(cp => {
      labelGroup.append('text')
        .attr('class', 'cat-label')
        .attr('x', xScale(cp.x))
        .attr('y', -10)
        .attr('text-anchor', 'middle')
        .attr('fill', 'var(--text-muted)')
        .attr('font-size', '10px')
        .text(cp.cat);
    });

    // Draw worldline paths (connecting papers in a worldline in time order)
    if (showWorldlines) worldlines.forEach(wl => {
      const wlPaperPositions = Array.from(wl.paperIds)
        .map(id => ({ id, pos: paperPositions.get(id) }))
        .filter((p): p is { id: number; pos: { x: number; y: number } } => !!p.pos)
        .sort((a, b) => a.pos.y - b.pos.y); // sort by time

      if (wlPaperPositions.length < 2) return;

      const lineGen = d3.line<{ id: number; pos: { x: number; y: number } }>()
        .x(d => xScale(d.pos.x))
        .y(d => yScale(d.pos.y))
        .curve(d3.curveCatmullRom.alpha(0.5));

      const isActiveWl = activeWorldlineId === wl.id;
      const pathColor = isActiveWl ? wl.color : 'var(--text-muted)';
      const pathOpacity = isActiveWl ? 0.3 : 0.1;

      chartArea.append('path')
        .datum(wlPaperPositions)
        .attr('d', lineGen)
        .attr('fill', 'none')
        .attr('stroke', pathColor)
        .attr('stroke-width', 3)
        .attr('stroke-opacity', pathOpacity)
        .attr('stroke-linecap', 'round');
    });

    // Draw paper nodes
    const nodes = chartArea.append('g').attr('class', 'paper-nodes');

    papers.forEach(p => {
      const pos = paperPositions.get(p.id);
      if (!pos) return;

      // Determine node appearance
      let fillColor = 'var(--text-muted)';
      let strokeColor = 'var(--border-color)';
      let radius = 5;
      let strokeWidth = 1.5;

      // Check if in any worldline
      const belongsToWorldlines: WorldlineWithPapers[] = [];
      worldlines.forEach(wl => {
        if (wl.paperIds.has(p.id)) {
          belongsToWorldlines.push(wl);
        }
      });

      // Hide papers not assigned to any worldline when toggled off
      if (!showNonWorldlinePapers && belongsToWorldlines.length === 0) return;

      if (belongsToWorldlines.length > 0) {
        const activeWl = activeWorldlineId !== null
          ? belongsToWorldlines.find(wl => wl.id === activeWorldlineId)
          : null;

        if (activeWl) {
          fillColor = activeWl.color;
          strokeColor = activeWl.color;
        } else {
          fillColor = 'var(--text-muted)';
          strokeColor = 'var(--border-color)';
        }
        radius = 7;
        strokeWidth = 2;
      }

      const isSelected = selectedPaperIds.has(p.id);
      if (isSelected) {
        strokeColor = 'var(--accent)';
        strokeWidth = 3;
        radius = 8;
      }

      const node = nodes.append('circle')
        .attr('cx', xScale(pos.x))
        .attr('cy', yScale(pos.y))
        .attr('r', radius)
        .attr('fill', fillColor)
        .attr('stroke', strokeColor)
        .attr('stroke-width', strokeWidth)
        .attr('cursor', 'pointer')
        .attr('data-paper-id', p.id)
        // Store base values for hover restore
        .attr('data-base-r', radius)
        .attr('data-base-sw', strokeWidth);

      // Hover handlers — update node directly via D3, plus set React state
      // for the HTML tooltip. No full re-render.
      node.on('mouseenter', function (event: MouseEvent) {
        const el = d3.select(this);
        const baseR = +el.attr('data-base-r');
        const baseSW = +el.attr('data-base-sw');
        el.attr('r', baseR + 2).attr('stroke-width', baseSW + 1);

        setHoveredPaperId(p.id);
        setTooltipPos({ x: event.clientX, y: event.clientY });
      });

      node.on('mousemove', function (event: MouseEvent) {
        setTooltipPos({ x: event.clientX, y: event.clientY });
      });

      node.on('mouseleave', function () {
        const el = d3.select(this);
        el.attr('r', el.attr('data-base-r'))
          .attr('stroke-width', el.attr('data-base-sw'));

        setHoveredPaperId(null);
        setTooltipPos(null);
      });

      node.on('click', (event: MouseEvent) => {
        event.stopPropagation();
        // Delay toggle so a rapid second click (dblclick) can cancel it
        if (clickTimerRef.current) {
          clearTimeout(clickTimerRef.current);
          clickTimerRef.current = null;
        }
        clickTimerRef.current = setTimeout(() => {
          clickTimerRef.current = null;
          toggleSelection(p.id);
          // Activate the worldline this paper belongs to
          if (belongsToWorldlines.length > 0) {
            setActiveWorldlineId(belongsToWorldlines[0].id);
          }
        }, 250);
      });

      node.on('dblclick', (event: MouseEvent) => {
        event.stopPropagation();
        if (clickTimerRef.current) {
          clearTimeout(clickTimerRef.current);
          clickTimerRef.current = null;
        }
        onOpenPaperRef.current(p);
      });

    });

    // Axis styling
    svg.selectAll('.wl-axis text')
      .attr('fill', 'var(--text-muted)')
      .attr('font-size', '11px');
    svg.selectAll('.wl-axis line, .wl-axis path')
      .attr('stroke', 'var(--border-color)');

    // Y-axis label
    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -innerH / 2)
      .attr('y', -55)
      .attr('text-anchor', 'middle')
      .attr('fill', 'var(--text-muted)')
      .attr('font-size', '12px')
      .text('Publication Date');

  }, [papers, paperPositions, worldlines, selectedPaperIds, activeWorldlineId, showWorldlines, showNonWorldlinePapers]);

  // Resize handler
  useEffect(() => {
    const handleResize = () => {
      // Force re-render by toggling a ref
      if (svgRef.current && containerRef.current) {
        const width = containerRef.current.clientWidth;
        const height = containerRef.current.clientHeight;
        d3.select(svgRef.current).attr('width', width).attr('height', height);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const toggleSelection = (paperId: number) => {
    setSelectedPaperIds(prev => {
      const next = new Set(prev);
      if (next.has(paperId)) next.delete(paperId);
      else next.add(paperId);
      return next;
    });
  };

  const handleCreateWorldline = async () => {
    if (!newWlName.trim()) return;
    try {
      const wl = await api.createWorldline(newWlName.trim(), newWlColor);
      // Add selected papers to this worldline
      const paperIds = Array.from(selectedPaperIds);
      for (let i = 0; i < paperIds.length; i++) {
        await api.addWorldlinePaper(wl.id, paperIds[i], i);
      }
      setNewWlName('');
      showNotification(`Created worldline "${wl.name}" with ${paperIds.length} papers`);
      setSelectedPaperIds(new Set());
      await loadData();
    } catch (err: any) {
      showNotification(err.message || 'Failed to create worldline');
    }
  };

  const handleDeleteWorldline = async (id: number) => {
    try {
      await api.deleteWorldline(id);
      if (activeWorldlineId === id) setActiveWorldlineId(null);
      showNotification('Worldline deleted');
      await loadData();
    } catch (err: any) {
      showNotification(err.message || 'Failed to delete worldline');
    }
  };

  const handleAddPapersToWorldline = async (wlId: number) => {
    try {
      const wl = worldlines.find(w => w.id === wlId);
      const existingCount = wl?.paperIds.size || 0;
      const paperIds = Array.from(selectedPaperIds);
      for (let i = 0; i < paperIds.length; i++) {
        await api.addWorldlinePaper(wlId, paperIds[i], existingCount + i);
      }
      showNotification(`Added ${paperIds.length} papers to worldline`);
      setSelectedPaperIds(new Set());
      await loadData();
    } catch (err: any) {
      showNotification(err.message || 'Failed to add papers');
    }
  };

  const handleRemovePaperFromWorldline = async (wlId: number, paperId: number) => {
    try {
      await api.removeWorldlinePaper(wlId, paperId);
      showNotification('Paper removed from worldline');
      await loadData();
    } catch (err: any) {
      showNotification(err.message || 'Failed to remove paper');
    }
  };

  const handleSelectWorldlinePapers = (wl: WorldlineWithPapers) => {
    setSelectedPaperIds(new Set(wl.paperIds));
    setActiveWorldlineId(wl.id);
  };

  const handleDeletePaper = async (paper: SavedPaper) => {
    if (!confirm(`Delete "${paper.title}" from your library?`)) return;
    try {
      await api.deletePaper(paper.id);
      showNotification('Paper deleted');
      await onRefresh();
      await loadData();
    } catch {
      showNotification('Failed to delete paper');
    }
  };

  // Load worldline chat sessions when active worldline changes
  useEffect(() => {
    if (activeWorldlineId !== null) {
      const sessions = api.getWorldlineChatSessions(activeWorldlineId);
      setWlChatSessions(sessions);
      // Resume most recent session if available
      if (sessions.length > 0 && !wlChatSessionId) {
        setWlChatSessionId(sessions[0].id);
        setWlChatMessages(sessions[0].messages);
      }
    } else {
      setWlChatOpen(false);
      setWlChatMessages([]);
      setWlChatSessionId(null);
      setWlChatSessions([]);
      setWlChatShowHistory(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorldlineId]);

  // Scroll chat to bottom when messages change
  useEffect(() => {
    wlChatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [wlChatMessages]);

  const generateId = (): string => {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  };

  const persistWlChatSession = useCallback((sessionMessages: ChatMessage[], sessionId: string | null) => {
    if (!sessionId || sessionMessages.length === 0 || activeWorldlineId === null) return;
    const wl = worldlines.find(w => w.id === activeWorldlineId);
    if (!wl) return;
    const existing = api.getWorldlineChatSession(sessionId);
    const session: WorldlineChatSession = {
      id: sessionId,
      worldlineId: activeWorldlineId,
      worldlineName: wl.name,
      messages: sessionMessages,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    api.saveWorldlineChatSession(session);
    setWlChatSessions(api.getWorldlineChatSessions(activeWorldlineId));
  }, [activeWorldlineId, worldlines]);

  const handleWlChatSend = async () => {
    const trimmed = wlChatInput.trim();
    if (!trimmed || wlChatLoading || activeWorldlineId === null) return;

    const settings = api.getSettings();
    if (!settings.claudeApiKey) {
      showNotification('Please set your Claude API key in Settings first.');
      return;
    }

    const wl = worldlines.find(w => w.id === activeWorldlineId);
    if (!wl) return;

    // Build paper context from worldline papers
    const wlPapers = papers.filter(p => wl.paperIds.has(p.id));
    const paperContexts = wlPapers.map(p => ({
      title: p.title,
      authors: (() => { try { return JSON.parse(p.authors) as string[]; } catch { return []; } })(),
      summary: p.summary,
      arxivId: p.arxiv_id,
    }));

    let currentSessionId = wlChatSessionId;
    if (!currentSessionId) {
      currentSessionId = generateId();
      setWlChatSessionId(currentSessionId);
    }

    const userMessage: ChatMessage = { role: 'user', content: trimmed };
    const updatedMessages = [...wlChatMessages, userMessage];
    setWlChatMessages(updatedMessages);
    setWlChatInput('');
    setWlChatLoading(true);

    try {
      const response = await api.sendWorldlineChatMessage(
        updatedMessages,
        settings.claudeApiKey,
        { worldlineName: wl.name, papers: paperContexts }
      );

      const usage = response.usage;
      let estimatedCost: number | undefined;
      if (usage) {
        const inputCost = (usage.input_tokens / 1_000_000) * 3;
        const outputCost = (usage.output_tokens / 1_000_000) * 15;
        estimatedCost = inputCost + outputCost;
      }

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.message,
        usage: usage ? {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
          estimated_cost: estimatedCost,
          model: response.model,
        } : undefined,
      };

      const withResponse = [...updatedMessages, assistantMessage];
      setWlChatMessages(withResponse);
      persistWlChatSession(withResponse, currentSessionId);
    } catch (err: any) {
      showNotification(err.message || 'Failed to get response from Claude');
      const withError = [...updatedMessages, { role: 'assistant' as const, content: 'Error: Failed to get a response. Please check your API key in Settings.' }];
      setWlChatMessages(withError);
      persistWlChatSession(withError, currentSessionId);
    } finally {
      setWlChatLoading(false);
    }
  };

  const handleWlChatKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleWlChatSend();
    }
  };

  const handleWlNewChat = () => {
    const newId = generateId();
    setWlChatSessionId(newId);
    setWlChatMessages([]);
    setWlChatShowHistory(false);
  };

  const handleWlSwitchSession = (session: WorldlineChatSession) => {
    setWlChatSessionId(session.id);
    setWlChatMessages(session.messages);
    setWlChatShowHistory(false);
  };

  const handleWlDeleteSession = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    api.deleteWorldlineChatSession(sessionId);
    if (activeWorldlineId !== null) {
      const updated = api.getWorldlineChatSessions(activeWorldlineId);
      setWlChatSessions(updated);
      if (sessionId === wlChatSessionId) {
        if (updated.length > 0) {
          setWlChatSessionId(updated[0].id);
          setWlChatMessages(updated[0].messages);
        } else {
          setWlChatSessionId(null);
          setWlChatMessages([]);
        }
      }
    }
  };

  const wlChatFirstUserMsg = (s: WorldlineChatSession) => {
    const first = s.messages.find(m => m.role === 'user');
    return first ? first.content.slice(0, 60) + (first.content.length > 60 ? '...' : '') : 'Empty session';
  };

  // Get short first author name
  const getFirstAuthor = (p: SavedPaper): string => {
    try {
      const authors = JSON.parse(p.authors) as string[];
      if (authors.length === 0) return 'Unknown';
      const name = authors[0];
      const parts = name.split(' ');
      return parts[parts.length - 1] + (authors.length > 1 ? ' et al.' : '');
    } catch {
      return 'Unknown';
    }
  };

  const getYear = (p: SavedPaper): string => {
    return new Date(p.published).getFullYear().toString();
  };

  if (papers.length === 0) {
    return (
      <div className="worldline-panel">
        <div className="empty-state">
          No papers in library. Save papers from the Browse tab to visualize worldlines.
        </div>
      </div>
    );
  }

  return (
    <div className="worldline-panel">
      {/* Visualization area */}
      <div className="wl-main">
        <div className="wl-chart" ref={containerRef}>
          <svg ref={svgRef} />
          {/* HTML tooltip — rendered outside SVG, pointer-events: none */}
          {hoveredPaperId !== null && tooltipPos && (() => {
            const hp = papers.find(p => p.id === hoveredPaperId);
            if (!hp) return null;
            const displayTitle = hp.title.length > 80 ? hp.title.substring(0, 77) + '...' : hp.title;
            const dateStr = new Date(hp.published).toLocaleDateString();
            const chartRect = containerRef.current?.getBoundingClientRect();
            if (!chartRect) return null;
            return (
              <div
                className="wl-tooltip"
                style={{
                  left: tooltipPos.x - chartRect.left,
                  top: tooltipPos.y - chartRect.top - 45,
                }}
              >
                <div className="wl-tooltip-title"><LaTeX>{displayTitle}</LaTeX></div>
                <div className="wl-tooltip-date">{getFirstAuthor(hp)} &middot; {dateStr}</div>
              </div>
            );
          })()}
        </div>

        {/* Toggle sidebar */}
        <button
          className="sidebar-toggle"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          title={sidebarOpen ? 'Hide panel' : 'Show panel'}
        >
          {sidebarOpen ? '\u25B6' : '\u25C0'}
        </button>

        {/* Sidebar */}
        {sidebarOpen && <div className="wl-sidebar-backdrop active" onClick={() => setSidebarOpen(false)} />}
        {sidebarOpen && (
          <div className="wl-sidebar">
            {/* Visibility toggles */}
            <div className="wl-section">
              <h4>Visibility</h4>
              <label className="wl-toggle-row">
                <input
                  type="checkbox"
                  checked={showWorldlines}
                  onChange={() => setShowWorldlines(v => !v)}
                />
                <span>Worldline Paths</span>
              </label>
              <label className="wl-toggle-row">
                <input
                  type="checkbox"
                  checked={showNonWorldlinePapers}
                  onChange={() => setShowNonWorldlinePapers(v => !v)}
                />
                <span>Unassigned Papers</span>
              </label>
            </div>

            {/* Selected papers */}
            <div className="wl-section">
                <div className="wl-section-header">
                  <h4>Selected ({selectedPaperIds.size})</h4>
                  {selectedPaperIds.size > 0 && (
                    <button className="btn-link" onClick={() => { setSelectedPaperIds(new Set()); setActiveWorldlineId(null); }}>
                      Clear
                    </button>
                  )}
                </div>
                {selectedPaperIds.size > 0 && (
                  <div className="wl-selected-list">
                    {Array.from(selectedPaperIds).map(id => {
                      const p = papers.find(pp => pp.id === id);
                      if (!p) return null;
                      return (
                        <div key={id} className="wl-selected-item">
                          <span className="wl-selected-name" title={p.title}>
                            {getFirstAuthor(p)} ({getYear(p)})
                          </span>
                          <button
                            className="btn-icon btn-danger-icon"
                            onClick={() => toggleSelection(id)}
                            title="Deselect"
                          >
                            &times;
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Create worldline from selection */}
                {selectedPaperIds.size >= 1 && (
                  <div className="wl-create-form">
                    <input
                      type="text"
                      value={newWlName}
                      onChange={e => setNewWlName(e.target.value)}
                      placeholder="Worldline name..."
                      onKeyDown={e => e.key === 'Enter' && handleCreateWorldline()}
                    />
                    <input
                      type="color"
                      value={newWlColor}
                      onChange={e => setNewWlColor(e.target.value)}
                    />
                    <button
                      className="btn btn-sm btn-success"
                      onClick={handleCreateWorldline}
                      disabled={!newWlName.trim()}
                    >
                      Create
                    </button>
                  </div>
                )}

                {/* Add to existing worldline */}
                {selectedPaperIds.size > 0 && worldlines.length > 0 && (
                  <div className="wl-add-to-existing">
                    <span className="wl-label">Add to:</span>
                    {worldlines.map(wl => (
                      <button
                        key={wl.id}
                        className="btn btn-sm"
                        style={{ background: wl.color, color: '#fff' }}
                        onClick={() => handleAddPapersToWorldline(wl.id)}
                        title={`Add selected papers to "${wl.name}"`}
                      >
                        {wl.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

            {/* Worldlines list */}
            <div className="wl-section">
              <h4>Worldlines ({worldlines.length})</h4>
              {worldlines.length === 0 && (
                <p className="muted">Select papers and create a worldline to group them.</p>
              )}
              {worldlines.map(wl => (
                <div
                  key={wl.id}
                  className={`wl-item ${activeWorldlineId === wl.id ? 'active' : ''}`}
                >
                  <div className="wl-item-header">
                    <span
                      className="wl-item-dot"
                      style={{ background: wl.color }}
                    />
                    <span
                      className="wl-item-name"
                      onClick={() => handleSelectWorldlinePapers(wl)}
                      title="Click to select this worldline's papers"
                    >
                      {wl.name}
                    </span>
                    <span className="wl-item-count">{wl.paperIds.size}</span>
                    <button
                      className="btn-icon btn-danger-icon"
                      onClick={() => handleDeleteWorldline(wl.id)}
                      title="Delete worldline"
                    >
                      &times;
                    </button>
                  </div>
                  {activeWorldlineId === wl.id && (
                    <>
                    <div className="wl-item-papers">
                      {Array.from(wl.paperIds).map(pid => {
                        const p = papers.find(pp => pp.id === pid);
                        if (!p) return null;
                        return (
                          <div key={pid} className="wl-item-paper">
                            <span title={p.title}>
                              {getFirstAuthor(p)} ({getYear(p)})
                            </span>
                            <button
                              className="btn-icon btn-danger-icon"
                              onClick={() => handleRemovePaperFromWorldline(wl.id, pid)}
                              title="Remove from worldline"
                            >
                              &times;
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    <button
                      className="btn btn-sm btn-primary wl-chat-toggle"
                      onClick={() => setWlChatOpen(prev => !prev)}
                    >
                      {wlChatOpen ? 'Hide Chat' : 'Ask Claude'}
                    </button>
                    </>
                  )}
                </div>
              ))}
            </div>

            {/* Worldline Chat Panel */}
            {wlChatOpen && activeWorldline && (
              <div className="wl-section wl-chat-section">
                <div className="wl-section-header">
                  <h4>Chat: {activeWorldline.name}</h4>
                </div>

                {!api.getSettings().claudeApiKey && (
                  <div className="wl-chat-no-key">
                    Set your Claude API key in Settings to use chat.
                  </div>
                )}

                {/* Session toolbar */}
                <div className="wl-chat-session-bar">
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setWlChatShowHistory(!wlChatShowHistory)}
                  >
                    History ({wlChatSessions.length})
                  </button>
                  <button className="btn btn-primary btn-sm" onClick={handleWlNewChat}>
                    + New
                  </button>
                </div>

                {wlChatShowHistory && wlChatSessions.length > 0 && (
                  <div className="wl-chat-session-list">
                    {wlChatSessions.map(s => (
                      <div
                        key={s.id}
                        className={`wl-chat-session-item ${s.id === wlChatSessionId ? 'active' : ''}`}
                        onClick={() => handleWlSwitchSession(s)}
                      >
                        <div className="wl-chat-session-text">
                          <span className="wl-chat-session-preview">{wlChatFirstUserMsg(s)}</span>
                          <span className="wl-chat-session-date">
                            {new Date(s.updatedAt).toLocaleDateString()} &middot; {s.messages.length} msgs
                          </span>
                        </div>
                        <button
                          className="btn-icon btn-danger-icon"
                          onClick={e => handleWlDeleteSession(s.id, e)}
                          title="Delete session"
                        >
                          &times;
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="wl-chat-messages">
                  {wlChatMessages.length === 0 && api.getSettings().claudeApiKey && (
                    <div className="wl-chat-welcome">
                      <p>Ask Claude about this worldline. Examples:</p>
                      <ul>
                        <li>"Summarize the research trajectory"</li>
                        <li>"How do these papers connect?"</li>
                        <li>"What are the key contributions?"</li>
                      </ul>
                    </div>
                  )}

                  {wlChatMessages.map((msg, i) => (
                    <div key={i} className={`wl-chat-message wl-chat-message-${msg.role}`}>
                      <div className="wl-chat-message-label">
                        {msg.role === 'user' ? 'You' : 'Claude'}
                      </div>
                      <div className={`wl-chat-message-content ${msg.role === 'assistant' ? 'markdown-body' : ''}`}>
                        {msg.role === 'assistant' ? (
                          <Markdown>{msg.content}</Markdown>
                        ) : (
                          msg.content
                        )}
                      </div>
                      {msg.role === 'assistant' && msg.usage && (
                        <div className="wl-chat-message-usage">
                          {msg.usage.model && <span>{msg.usage.model}</span>}
                          <span>{msg.usage.input_tokens.toLocaleString()} in / {msg.usage.output_tokens.toLocaleString()} out</span>
                          {msg.usage.estimated_cost !== undefined && (
                            <span>${msg.usage.estimated_cost < 0.01
                              ? msg.usage.estimated_cost.toFixed(4)
                              : msg.usage.estimated_cost.toFixed(3)}</span>
                          )}
                        </div>
                      )}
                    </div>
                  ))}

                  {wlChatLoading && (
                    <div className="wl-chat-message wl-chat-message-assistant">
                      <div className="wl-chat-message-label">Claude</div>
                      <div className="wl-chat-message-content wl-chat-typing">
                        Thinking...
                      </div>
                    </div>
                  )}

                  <div ref={wlChatEndRef} />
                </div>

                <div className="wl-chat-input-area">
                  <textarea
                    className="wl-chat-input"
                    value={wlChatInput}
                    onChange={e => setWlChatInput(e.target.value)}
                    onKeyDown={handleWlChatKeyDown}
                    placeholder={api.getSettings().claudeApiKey ? 'Ask about this worldline...' : 'Set API key in Settings first'}
                    rows={2}
                    disabled={!api.getSettings().claudeApiKey || wlChatLoading}
                  />
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={handleWlChatSend}
                    disabled={!wlChatInput.trim() || wlChatLoading || !api.getSettings().claudeApiKey}
                  >
                    Send
                  </button>
                </div>
              </div>
            )}

            {/* Paper list for reference */}
            <div className="wl-section">
              <h4
                className="wl-collapsible-header"
                onClick={() => setAllPapersOpen(prev => !prev)}
              >
                <span className={`wl-collapse-chevron ${allPapersOpen ? 'open' : ''}`}>{'\u25B6'}</span>
                All Papers ({papers.length})
              </h4>
              {allPapersOpen && (
                <div className="wl-paper-list">
                  {papers
                    .slice()
                    .sort((a, b) => new Date(a.published).getTime() - new Date(b.published).getTime())
                    .map(p => {
                      const isSelected = selectedPaperIds.has(p.id);
                      return (
                        <div
                          key={p.id}
                          className={`wl-paper-item ${isSelected ? 'selected' : ''}`}
                          onClick={() => toggleSelection(p.id)}
                          onMouseEnter={() => setHoveredPaperId(p.id)}
                          onMouseLeave={() => setHoveredPaperId(null)}
                        >
                          <div className="wl-paper-item-info">
                            <span className="wl-paper-title" title={p.title}>
                              {p.title.length > 50 ? p.title.substring(0, 47) + '...' : p.title}
                            </span>
                            <span className="wl-paper-meta-small">
                              {getFirstAuthor(p)} &middot; {getYear(p)}
                            </span>
                          </div>
                          <button
                            className="btn-icon btn-danger-icon wl-paper-delete-btn"
                            onClick={(e) => { e.stopPropagation(); handleDeletePaper(p); }}
                            title="Delete from library"
                          >
                            &times;
                          </button>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
