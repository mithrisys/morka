(() => {
  const root = document.getElementById('morka-home');
  const canvas = root.querySelector('canvas');
  const context = canvas.getContext('2d');
  const handle = root.querySelector('button');
  const caption = document.getElementById('launcher-caption');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = (v, low, high) => Math.min(high, Math.max(low, v));
  const smooth = v => { const t = clamp(v,0,1); return t*t*(3-2*t); };

  // Broad reflections and violet rim light follow the membrane's curvature.
  const resolution = 384;
  const material = new Uint32Array(resolution * resolution);
  const light = (x,y,sx,sy) => Math.exp(-x*x/(sx*sx)-y*y/(sy*sy));
  const pixel = (r,g,b) => (255<<24)|(clamp(Math.round(b),0,255)<<16)|(clamp(Math.round(g),0,255)<<8)|clamp(Math.round(r),0,255);
  for (let j=0; j<resolution; j++) {
    for (let i=0; i<resolution; i++) {
      let x = 2*i/(resolution-1)-1, y = 2*j/(resolution-1)-1;
      const len = Math.max(1,Math.hypot(x,y)); x/=len; y/=len;
      const z = Math.sqrt(Math.max(0,1-x*x-y*y));
      const edge = Math.pow(1-z,2.7);
      const top = light(x+.26,y+.53,.74,.43);
      const reflection = light(x-.41,y-.46,.45,.29);
      const arc = Math.exp(-Math.pow((Math.hypot((x-.03)*1.02,(y-.03)*.95)-.875)/.055,2)) * smooth((y+.06)/.84);
      const inner = light(x+.4,y-.13,.43,.45);
      const gleam = light(x+.61,y+.49,.16,.10);
      const core = .42+.54*z;
      material[j*resolution+i]=pixel(
        53+39*core+83*top+58*reflection+57*arc+112*edge+17*inner+20*gleam,
        10+7*core+90*top+21*reflection+56*arc+81*edge+5*inner+25*gleam,
        126+68*core+42*top+49*reflection+49*arc+42*edge+16*inner+23*gleam);
    }
  }

  const raster = document.createElement('canvas');
  const rasterContext = raster.getContext('2d');
  let image, pixels, profile, scale, width, height, radius, anchor, cy, travel, breaking, rest;
  let desired=0, separation=0, velocity=0, pull=0, pullSpeed=0, tilt=0, tiltTarget=0;
  let split=false, pointer=null, downX=0, downY=0, downDistance=0;
  let phase='ready';
  let frame=0, last=0, active=false;
  let pinchTime=0;
  const daughterMass = .455;
  const parentFlow = {open:0, speed:0};
  const daughterFlow = {open:0, speed:0};

  function relaxMembrane(flow, rate, dt) {
    const goal = split ? 1 : 0;
    if (reduced.matches) { flow.open=goal; flow.speed=0; return; }
    // Critical damping gives the membrane a finite retraction speed even at pinch-off.
    flow.speed += (rate*rate*(goal-flow.open) - 2*rate*flow.speed)*dt;
    flow.open = clamp(flow.open+flow.speed*dt,0,1);
  }

  function outerEnvelope(left, right, softness) {
    if (softness <= .0001) return Math.max(left,right);
    const mix = Math.max(0,1-Math.abs(left-right)/softness);
    return Math.max(left,right) + softness*mix*mix*mix/6;
  }


  function verticalCoverage(height, offset) {
    return Math.max(0,Math.min(height,offset+.5)-Math.max(-height,offset-.5));
  }

  function layout() {
    width=root.clientWidth; height=root.clientHeight;
    if (width<1) return;
    scale=Math.min(devicePixelRatio||1,2);
    radius=Math.min(101,width*.126); cy=height*.402;
    travel=Math.min(4.8,(width*.63-16)/radius-.94);
    breaking=Math.min(3.66,travel*.81); rest=Math.min(travel,breaking+.52);
    // Center the outer edges of the two settled cells, accounting for their unequal radii.
    const leftRadius=radius*Math.cbrt(1-daughterMass), rightRadius=radius*Math.cbrt(daughterMass);
    anchor=(width-rest*radius+leftRadius-rightRadius)/2;
    if (phase==='naming') desired=rest;
    if (!active && pointer===null) desired=separation=split?rest:0;
    canvas.width=Math.round(width*scale); canvas.height=Math.round(height*scale);
    context.setTransform(scale,0,0,scale,0,0);
    // The tight backing surface avoids shading an entire white window on every frame.
    raster.width=Math.ceil((travel+3.1)*radius*scale); raster.height=Math.ceil(2.6*radius*scale);
    image=rasterContext.createImageData(raster.width,raster.height); pixels=new Uint32Array(image.data.buffer);
    profile=new Float32Array(raster.width);
    caption.style.top=Math.min(cy+radius+Math.min(63, width*.09), height-caption.offsetHeight-14)+'px'; draw();
  }

  function shadow(x,y,rx,opacity) {
    context.save();
    context.translate(x,y);
    context.scale(rx,rx*.13);
    const gradient=context.createRadialGradient(0,0,0,0,0,1);
    gradient.addColorStop(0,`rgba(65,28,97,${opacity})`);
    gradient.addColorStop(.5,`rgba(79,37,114,${opacity*.38})`);
    gradient.addColorStop(1,'rgba(97,56,138,0)');
    context.fillStyle=gradient;
    context.fillRect(-1,-1,2,2);
    context.restore();
  }

  function draw() {
    if (!image) return;
    const growth=smooth(separation/(breaking*.64));
    const mass=daughterMass*growth;
    const stretch=clamp(pull,-.45,1.12);
    const a=Math.cbrt(1-mass), b=Math.cbrt(mass);
    const ax=a*(1+.21*stretch), ay=a/(1+.15*stretch);
    const bx=b*(1+.13*stretch), by=b/(1+.10*stretch);
    const xA=.20*stretch,xB=separation;
    const tension=clamp(separation/breaking,0,1);
    const span=Math.max(.00001,xB-xA);
    const pinchX=xA+span*(.50+.047*smooth(tension));
    const stretchBlend=smooth((separation-.95)/.75);
    const budSoftness=1.4*smooth(separation/1.05);
    // A soft union of two pressure fields has one contour on both sides of fission.
    // As the saddle crosses zero, a hairline gap opens first at the narrowest point.
    const fusion=1.32+1.48*(1-smooth((tension-.46)/.3));
    const remaining=1-smooth((tension-.28)/.72);
    const throat=.045+.56*remaining;
    const bondedHalfLength=Math.sqrt(1+fusion/6-throat*throat);
    const nativeLeft=(pinchX-xA)/ax;
    const nativeRight=(xB-pinchX)/Math.max(.0001,bx);
    // Displacement starts at zero velocity while surface tension draws the tips inward.
    const leftRetraction=parentFlow.open**2;
    const rightRetraction=daughterFlow.open**2;
    const avgOpen=(leftRetraction+rightRetraction)*.5;
    const fieldBlend=fusion*(1-avgOpen);
    const halfLength=bondedHalfLength+(Math.max(nativeLeft,nativeRight)-bondedHalfLength)*avgOpen;
    // Let the shorter daughter's tip round off sooner. Each intact outer hemisphere
    // keeps its curvature while the inner material feeds back into the cell.
    const virtualLeft=halfLength+(nativeLeft-halfLength)*leftRetraction;
    const virtualRight=halfLength+(nativeRight-halfLength)*rightRetraction;
    const rs=radius*scale, row=(raster.height-1)*.5;
    const minX=Math.max(0,Math.floor((xA-ax+1.52-.18)*rs)-2);
    const maxX=Math.min(raster.width-1,Math.ceil((Math.max(xA+ax,xB+bx)+1.52+.18)*rs)+2);
    for(let col=minX;col<=maxX;col++) {
      const x=(col+.5)/rs-1.52;
      // Blend signed squared radii before extracting the surface. Clipping each
      // sphere first carries its sharp silhouette into the middle of the neck.
      const parentField=ay*ay*(1-((x-xA)/ax)**2);
      const daughterField=bx>0 ? by*by*(1-((x-xB)/bx)**2) : -Infinity;
      const budField=outerEnvelope(parentField,daughterField,budSoftness);
      let stretchedField=x<=xA ? parentField : daughterField;
      if (stretchBlend>0 && x>xA && x<xB) {
        const left=x<=pinchX;
        const half=left?virtualLeft:virtualRight;
        const sideSpan=left?pinchX-xA:xB-pinchX;
        const rx=left?ax:bx;
        const t=(left?x-xA:xB-x)/sideSpan;
        const ratio=half*rx/sideSpan;
        // Stretch material coordinates toward the neck. The derivative at each
        // cell center matches its round outer half, keeping the shading smooth.
        const u=half*t/(ratio+(1-ratio)*t);
        const opposing=2*half-u;
        const field=outerEnvelope(1-u*u,1-opposing*opposing,fieldBlend);
        const sharedHeight=(ay+by)*.5;
        const ownHeight=left?ay:by;
        const localHeight=ownHeight+(sharedHeight-ownHeight)*smooth(t)*(1-avgOpen);
        const taper=1-.52*smooth((t-.4)/.54)*tension*tension*(1-avgOpen);
        stretchedField=(localHeight*taper)**2*field;
      }
      const surface=stretchBlend===0 ? budField : budField+(stretchedField-budField)*stretchBlend;
      profile[col]=surface*rs*rs;
    }
    pixels.fill(0);
    const cosine=Math.cos(tilt), vertical=Math.sin(tilt);
    const normalMid=(resolution-1)*.5;
    for(let col=minX+1;col<maxX;col++) {
      const field=profile[col], derivative=(profile[col+1]-profile[col-1])*.5;
      // Four horizontal samples and exact vertical coverage also smooth the
      // near-vertical ends, where sampling only the column center leaves steps.
      const eighth=Math.abs(derivative)/8;
      if(field+3*eighth<=0) continue;
      const h0=Math.sqrt(Math.max(0,field-3*eighth));
      const h1=Math.sqrt(Math.max(0,field-eighth));
      const h2=Math.sqrt(Math.max(0,field+eighth));
      const h3=Math.sqrt(field+3*eighth);
      const normalLength=Math.max(.001,Math.sqrt(derivative**2+4*Math.max(0,field)));
      const axial=-derivative/normalLength*normalMid;
      const centerX=normalMid+axial*cosine, centerY=normalMid+axial*vertical;
      const first=Math.max(0,Math.ceil(row-h3-.5)), end=Math.min(raster.height-1,Math.floor(row+h3+.5));
      const factor=2*normalMid/normalLength;
      const stepX=-vertical*factor, stepY=cosine*factor;
      for(let y=first;y<=end;y++) {
        const dy=y-row;
        const nx=clamp(Math.round(centerX+dy*stepX),0,resolution-1);
        const ny=clamp(Math.round(centerY+dy*stepY),0,resolution-1);
        const color=material[ny*resolution+nx];
        if(Math.abs(dy)+.5<=h0) {
          pixels[y*raster.width+col]=color;
        } else {
          const coverage=(verticalCoverage(h0,dy)+verticalCoverage(h1,dy)
            +verticalCoverage(h2,dy)+verticalCoverage(h3,dy))*.25;
          pixels[y*raster.width+col]=(color&0x00ffffff)|(Math.round(coverage*255)<<24);
        }
      }
    }
    rasterContext.putImageData(image,0,0);
    context.clearRect(0,0,width,height);
    const childX=anchor+xB*radius*cosine, childY=cy+xB*radius*vertical;
    const floor=cy+radius+10;
    shadow(anchor+xA*radius,floor,radius*1.02,.12*(1-.35*growth));
    if(growth>.001) shadow(childX,floor+vertical*radius*.24,radius*.85,.085*growth);
    context.save();context.translate(anchor,cy);context.rotate(tilt);
    context.drawImage(raster,-1.52*radius,-(row+.5)/scale,raster.width/scale,raster.height/scale);context.restore();
    handle.style.left=(separation>.06?childX:anchor+xA*radius)+'px';handle.style.top=(separation>.06?childY:cy)+'px';
    handle.style.width=handle.style.height=Math.max(44,(separation>.06?Math.max(bx,by):Math.max(ax,ay))*radius*2)+'px';
    root.dataset.motion=active?'moving':'idle';root.dataset.separated=String(split);root.dataset.distance=separation.toFixed(3);
  }

  function magneticDrag(t) {
    // The input-to-motion ratio falls from 1 to .33 before the membrane lets go.
    const reach=breaking/.75, fraction=clamp(t/reach,0,1);
    return t-reach*.25*Math.pow(fraction,2.68);
  }
  function tick(now) {
    frame=0;
    const elapsed=Math.min(.05,Math.max(0,(now-last)/1000)); last=now;
    const steps=Math.max(1,Math.ceil(elapsed*180)), dt=elapsed/steps;
    for(let i=0;i<steps;i++) {
      if(reduced.matches){separation=desired;velocity=0;} else {
        const k=pointer===null?170:480, damping=pointer===null?20:35;
        velocity+=((desired-separation)*k-velocity*damping)*dt;
        separation=clamp(separation+velocity*dt,0,travel);
      }
      if (!split && phase==='naming') {
        const load=clamp((separation/breaking-.97)/.08,0,1);
        pinchTime=clamp(pinchTime+dt*(load>0 ? .35+1.9*load : -3),0,.16);
        if (load>0 && (reduced.matches || pinchTime>=.16)) split=true;
      } else if (split && separation<1.48 && desired<1.48) {
        split=false;
      }
      relaxMembrane(parentFlow,7.4,dt);
      relaxMembrane(daughterFlow,9.2,dt);
      const strain=(1-parentFlow.open)*smooth((separation/breaking-.16)/.84);
      if(reduced.matches) {pull=strain;pullSpeed=0;tilt=tiltTarget;} else {
        pullSpeed+=((strain-pull)*245-16*pullSpeed)*dt; pull+=pullSpeed*dt;
        tilt+=(tiltTarget-tilt)*(1-Math.exp(-dt*15));
      }
    }
    const strain=(1-parentFlow.open)*smooth((separation/breaking-.16)/.84);
    const settled=Math.abs(desired-separation)<.0008 && Math.abs(velocity)<.008 && Math.abs(pull-strain)<.001 && Math.abs(pullSpeed)<.009 && Math.abs(parentFlow.open-Number(split))<.0005 && Math.abs(daughterFlow.open-Number(split))<.0005 && !(phase==='naming' && !split) && Math.abs(tilt-tiltTarget)<.001;
    if(settled){separation=desired;velocity=0;pull=strain;pullSpeed=0;tilt=tiltTarget;parentFlow.open=daughterFlow.open=Number(split);parentFlow.speed=daughterFlow.speed=0;active=false;}
    draw();
    if(!settled){frame=requestAnimationFrame(tick);return;}
    if(phase==='returning') phase='ready';
  }
  function wake() {
    active=true;
    if(!frame) { last=performance.now(); frame=requestAnimationFrame(tick); }
  }

  function endDrag() {
    if (pointer === null) return;
    const id = pointer;
    pointer = null;
    root.dataset.held = 'false';
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
  }

  function nameCell() {
    if (phase !== 'ready') return;
    endDrag();
    phase = 'naming';
    desired = rest;
    tiltTarget = 0;
    wake();
    handle.dispatchEvent(new Event('morka-divided'));
  }

  function retract() {
    endDrag();
    phase = 'returning';
    pinchTime = 0;
    desired = 0;
    tiltTarget = 0;
    wake();
  }

  handle.addEventListener('morka-reset', retract);
  handle.addEventListener('pointerdown', event => {
    if (phase !== 'ready' || pointer !== null || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    pointer = event.pointerId;
    downX = event.clientX;
    downY = event.clientY;
    desired = downDistance = separation;
    root.dataset.held = 'true';
    handle.setPointerCapture(pointer);
    wake();
  });

  function drag(event) {
    const dx = event.clientX - downX;
    const raw = Math.max(0, downDistance + dx / radius);
    desired = clamp(magneticDrag(raw), 0, travel);
    tiltTarget = clamp(Math.atan2((event.clientY-downY)*.42, Math.max(radius, dx+downDistance*radius)), -.22, .22)*smooth(raw/.8);
    if (desired >= breaking) nameCell();
    else wake();
  }
  window.addEventListener('pointermove', event => {
    if (event.pointerId !== pointer) return;
    event.preventDefault();
    drag(event);
  }, { passive:false });
  window.addEventListener('pointerup', event => {
    if (event.pointerId !== pointer) return;
    drag(event);
    if (pointer !== null) retract();
  });
  handle.addEventListener('lostpointercapture', event => { if (event.pointerId === pointer) retract(); });
  window.addEventListener('pointercancel', event => { if (event.pointerId === pointer) retract(); });
  window.addEventListener('blur', () => { if (pointer !== null) retract(); });
  // Screen readers can activate a button without a pointer sequence.
  handle.addEventListener('click', event => { if (event.detail === 0) nameCell(); });
  handle.addEventListener('keydown', event => {
    if (!['ArrowRight','Enter',' '].includes(event.key)) return;
    event.preventDefault();
    if (!event.repeat) nameCell();
  });
  layout();
  new ResizeObserver(layout).observe(root);
})();
