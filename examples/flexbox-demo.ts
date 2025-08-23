/**
 * Flexbox Layout Demo - Showcasing TOM's flexbox capabilities
 * 
 * This demo creates a sophisticated layout with multiple containers,
 * demonstrating various flexbox properties and nested layouts.
 */

import { createTTYWindow } from '../src/index.js';

function flexboxDemo() {
  console.log('🎯 Starting TTY Flexbox Layout Demo...\n');
  
  // Create TTY document
  const tty = createTTYWindow();
  
  // Create main container with column layout
  const mainContainer = tty.document.createElement('container');
  mainContainer.style.flexDirection = 'column';
  mainContainer.style.padding = [1, 2, 1, 2]; // top, right, bottom, left
  mainContainer.style.backgroundColor = 'blue';
  tty.document.body.appendChild(mainContainer);
  
  // Header section
  const header = tty.document.createElement('container');
  header.style.flexDirection = 'row';
  header.style.backgroundColor = 'cyan';
  header.style.padding = [1, 1, 1, 1];
  mainContainer.appendChild(header);
  
  const headerTitle = tty.document.createElement('text');
  headerTitle.textContent = '🚀 TTY Flexbox Demo';
  headerTitle.style.textAlign = 'center';
  headerTitle.style.color = 'black';
  header.appendChild(headerTitle);
  
  const headerSubtitle = tty.document.createElement('text');
  headerSubtitle.textContent = 'Terminal Object Model';
  headerSubtitle.style.textAlign = 'right';
  headerSubtitle.style.color = 'gray';
  header.appendChild(headerSubtitle);
  
  // Content area with horizontal layout
  const contentArea = tty.document.createElement('container');
  contentArea.style.flexDirection = 'row';
  contentArea.style.padding = [1, 0, 0, 0];
  mainContainer.appendChild(contentArea);
  
  // Left sidebar
  const sidebar = tty.document.createElement('container');
  sidebar.style.flexDirection = 'column';
  sidebar.style.backgroundColor = 'green';
  sidebar.style.padding = [1, 1, 1, 1];
  contentArea.appendChild(sidebar);
  
  const sidebarTitle = tty.document.createElement('text');
  sidebarTitle.textContent = '📋 Navigation';
  sidebarTitle.style.color = 'white';
  sidebarTitle.style.textAlign = 'center';
  sidebar.appendChild(sidebarTitle);
  
  const menuItems = ['• Home', '• About', '• Services', '• Contact'];
  for (const item of menuItems) {
    const menuItem = tty.document.createElement('text');
    menuItem.textContent = item;
    menuItem.style.color = 'lightGreen';
    menuItem.style.padding = [0, 1, 0, 1];
    sidebar.appendChild(menuItem);
  }
  
  // Main content area
  const mainContent = tty.document.createElement('container');
  mainContent.style.flexDirection = 'column';
  mainContent.style.backgroundColor = 'white';
  mainContent.style.padding = [1, 2, 1, 2];
  contentArea.appendChild(mainContent);
  
  const contentTitle = tty.document.createElement('text');
  contentTitle.textContent = '📄 Main Content Area';
  contentTitle.style.color = 'black';
  contentTitle.style.textAlign = 'center';
  mainContent.appendChild(contentTitle);
  
  const contentText = tty.document.createElement('text');
  contentText.textContent = 'This demonstrates flexbox layout with nested containers. The layout automatically adjusts based on flexDirection properties: column for vertical stacking, row for horizontal arrangement.';
  contentText.style.color = 'darkGray';
  contentText.style.padding = [1, 0, 1, 0];
  mainContent.appendChild(contentText);
  
  // Feature showcase area
  const featuresContainer = tty.document.createElement('container');
  featuresContainer.style.flexDirection = 'row';
  featuresContainer.style.padding = [1, 0, 0, 0];
  mainContent.appendChild(featuresContainer);
  
  const features = [
    { title: '🎨 Styling', desc: 'Rich terminal colors and formatting' },
    { title: '📐 Layout', desc: 'Flexbox-based positioning system' },
    { title: '⚡ Performance', desc: 'Efficient ScreenBuffer rendering' }
  ];
  
  for (const feature of features) {
    const featureCard = tty.document.createElement('container');
    featureCard.style.flexDirection = 'column';
    featureCard.style.backgroundColor = 'lightBlue';
    featureCard.style.padding = [1, 1, 1, 1];
    featuresContainer.appendChild(featureCard);
    
    const featureTitle = tty.document.createElement('text');
    featureTitle.textContent = feature.title;
    featureTitle.style.color = 'blue';
    featureTitle.style.textAlign = 'center';
    featureCard.appendChild(featureTitle);
    
    const featureDesc = tty.document.createElement('text');
    featureDesc.textContent = feature.desc;
    featureDesc.style.color = 'darkBlue';
    featureDesc.style.textAlign = 'center';
    featureCard.appendChild(featureDesc);
  }
  
  // Footer with reverse row layout
  const footer = tty.document.createElement('container');
  footer.style.flexDirection = 'row-reverse';
  footer.style.backgroundColor = 'magenta';
  footer.style.padding = [1, 2, 1, 2];
  mainContainer.appendChild(footer);
  
  const footerText = tty.document.createElement('text');
  footerText.textContent = '© 2024 Terminal Object Model';
  footerText.style.color = 'white';
  footer.appendChild(footerText);
  
  const footerVersion = tty.document.createElement('text');
  footerVersion.textContent = 'v1.0.0';
  footerVersion.style.color = 'lightMagenta';
  footer.appendChild(footerVersion);
  
  // Log layout structure
  console.log('📐 Layout Structure:');
  console.log('├── Main Container (column)');
  console.log('│   ├── Header (row)');
  console.log('│   │   ├── Title + Subtitle');
  console.log('│   ├── Content Area (row)');
  console.log('│   │   ├── Sidebar (column)');
  console.log('│   │   │   ├── Navigation items');
  console.log('│   │   ├── Main Content (column)');
  console.log('│   │   │   ├── Features (row)');
  console.log('│   │   │   │   ├── Feature cards (column)');
  console.log('│   ├── Footer (row-reverse)');
  console.log('');
  
  // Render the complete layout
  console.log('🎨 Rendering flexbox layout...\n');
  tty.document.render();
  
  console.log('\n✨ Flexbox demo complete!');
  console.log('🔍 Notice how elements are automatically positioned using flexbox rules:');
  console.log('   • Column layout stacks vertically');
  console.log('   • Row layout arranges horizontally');  
  console.log('   • Row-reverse layout arranges horizontally in reverse order');
  console.log('   • Nested containers create complex layouts');
  
  // Clean up
  setTimeout(() => {
    tty[Symbol.dispose]();
    console.log('\n🧹 Demo cleaned up');
  }, 100);
}

flexboxDemo();