/**
 * TOMViewport - Viewport abstraction for TOM, similar to browser viewport/document model
 * 
 * Provides viewport vs document dimensions, scrolling, and overflow handling.
 * Full-screen mode is just a special case where document height = viewport height.
 */

export interface ViewportDimensions {
  width: number;
  height: number;
}

export interface DocumentDimensions {
  width: number;
  height: number;
  scrollTop: number;
  scrollLeft: number;
}

export interface ViewportOptions {
  /** Viewport width (defaults to terminal width) */
  width?: number;
  
  /** Viewport height (defaults to terminal height for fullscreen, or 'auto' for flow) */
  height?: number | 'auto';
  
  /** Overflow behavior */
  overflow?: 'visible' | 'hidden' | 'scroll' | 'auto';
  
  /** Whether viewport is fixed (fullscreen) or flows with terminal content */
  position?: 'fixed' | 'relative';
}

export class TOMViewport {
  private viewport: ViewportDimensions;
  private document: DocumentDimensions;
  private options: Required<ViewportOptions>;
  
  constructor(options: ViewportOptions = {}) {
    this.options = {
      width: options.width ?? process.stdout.columns ?? 80,
      height: options.height ?? 'auto',
      overflow: options.overflow ?? 'auto',
      position: options.position ?? 'relative'
    };
    
    // Initialize viewport dimensions
    this.viewport = {
      width: this.options.width,
      height: this.options.height === 'auto' ? 0 : this.options.height
    };
    
    // Initialize document dimensions
    this.document = {
      width: this.viewport.width,
      height: 0,
      scrollTop: 0,
      scrollLeft: 0
    };
  }
  
  /**
   * Get current viewport dimensions
   */
  getViewport(): ViewportDimensions {
    return { ...this.viewport };
  }
  
  /**
   * Get current document dimensions
   */
  getDocument(): DocumentDimensions {
    return { ...this.document };
  }
  
  /**
   * Update document dimensions (e.g., after layout)
   */
  setDocumentSize(width: number, height: number): void {
    this.document.width = width;
    this.document.height = height;
    
    // Auto-adjust viewport height if in auto mode
    if (this.options.height === 'auto') {
      this.viewport.height = Math.min(height, process.stdout.rows ?? 24);
    }
    
    // Clamp scroll position
    this.clampScroll();
  }
  
  /**
   * Get visible area of document (what's currently in viewport)
   */
  getVisibleBounds(): { x: number; y: number; width: number; height: number } {
    return {
      x: this.document.scrollLeft,
      y: this.document.scrollTop,
      width: this.viewport.width,
      height: this.viewport.height
    };
  }
  
  /**
   * Check if a region is visible in viewport
   */
  isVisible(x: number, y: number, width: number, height: number): boolean {
    const visible = this.getVisibleBounds();
    
    return !(
      x + width < visible.x ||
      y + height < visible.y ||
      x > visible.x + visible.width ||
      y > visible.y + visible.height
    );
  }
  
  /**
   * Scroll document
   */
  scroll(deltaX: number, deltaY: number): boolean {
    const oldScrollTop = this.document.scrollTop;
    const oldScrollLeft = this.document.scrollLeft;
    
    this.document.scrollTop += deltaY;
    this.document.scrollLeft += deltaX;
    
    this.clampScroll();
    
    // Return true if scroll position changed
    return (
      this.document.scrollTop !== oldScrollTop ||
      this.document.scrollLeft !== oldScrollLeft
    );
  }
  
  /**
   * Scroll to specific position
   */
  scrollTo(x: number, y: number): boolean {
    const oldScrollTop = this.document.scrollTop;
    const oldScrollLeft = this.document.scrollLeft;
    
    this.document.scrollTop = y;
    this.document.scrollLeft = x;
    
    this.clampScroll();
    
    return (
      this.document.scrollTop !== oldScrollTop ||
      this.document.scrollLeft !== oldScrollLeft
    );
  }
  
  /**
   * Ensure element is visible (scroll if needed)
   */
  scrollIntoView(x: number, y: number, width: number, height: number): boolean {
    const visible = this.getVisibleBounds();
    let changed = false;
    
    // Scroll vertically if needed
    if (y < visible.y) {
      this.document.scrollTop = y;
      changed = true;
    } else if (y + height > visible.y + visible.height) {
      this.document.scrollTop = y + height - visible.height;
      changed = true;
    }
    
    // Scroll horizontally if needed
    if (x < visible.x) {
      this.document.scrollLeft = x;
      changed = true;
    } else if (x + width > visible.x + visible.width) {
      this.document.scrollLeft = x + width - visible.width;
      changed = true;
    }
    
    if (changed) {
      this.clampScroll();
    }
    
    return changed;
  }
  
  /**
   * Get rendering mode based on viewport configuration
   */
  getRenderingMode(): 'fullscreen' | 'flow' | 'windowed' {
    if (this.options.position === 'fixed') {
      return 'fullscreen';
    } else if (this.options.height === 'auto') {
      return 'flow';
    } else {
      return 'windowed';
    }
  }
  
  /**
   * Can content scroll?
   */
  canScroll(): { horizontal: boolean; vertical: boolean } {
    if (this.options.overflow === 'hidden') {
      return { horizontal: false, vertical: false };
    }
    
    return {
      horizontal: this.document.width > this.viewport.width,
      vertical: this.document.height > this.viewport.height
    };
  }
  
  /**
   * Clamp scroll position to valid range
   */
  private clampScroll(): void {
    const maxScrollTop = Math.max(0, this.document.height - this.viewport.height);
    const maxScrollLeft = Math.max(0, this.document.width - this.viewport.width);
    
    this.document.scrollTop = Math.max(0, Math.min(this.document.scrollTop, maxScrollTop));
    this.document.scrollLeft = Math.max(0, Math.min(this.document.scrollLeft, maxScrollLeft));
  }
  
  /**
   * Handle terminal resize
   */
  handleResize(width: number, height: number): void {
    this.viewport.width = width;
    
    if (this.options.height !== 'auto') {
      this.viewport.height = this.options.position === 'fixed' ? height : this.options.height;
    }
    
    this.clampScroll();
  }
}