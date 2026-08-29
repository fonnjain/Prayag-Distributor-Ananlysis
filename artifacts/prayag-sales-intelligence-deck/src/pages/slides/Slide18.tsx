import { BrandMark } from '../../DeckShared';

const base = import.meta.env.BASE_URL;

export default function Slide18() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-[#08121f]">
      <img src={`${base}control-room.jpg`} crossOrigin="anonymous" alt="Abstract blue sales intelligence control room" className="hero-image absolute inset-0 h-full w-full object-cover opacity-42" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(8,18,31,.98)_0%,rgba(8,18,31,.78)_62%,rgba(8,18,31,.35)_100%)]" />
      <div className="absolute left-[7vw] top-[7vh]"><BrandMark /></div>
      <div className="absolute left-[7vw] top-[32vh]">
        <div className="eyebrow">PRAYAG SALES INTELLIGENCE</div>
        <h1 className="display-head-xl mt-[2.5vh] max-w-[61vw]">From signal to action</h1>
        <div className="mt-[4vh] h-[.18vw] w-[17vw] bg-[#f3b44b]" />
        <p className="mt-[3vh] font-display text-[2.4vw] font-medium tracking-[-.04em] text-[#e1ebef]">See the business clearly. Find the opportunity. Move the field.</p>
      </div>
      <div className="absolute bottom-[7vh] left-[7vw] right-[7vw] flex items-center justify-between border-t-[.08vw] border-[#a9b7c2]/25 pt-[1.5vh]"><span className="text-[1.5vw] uppercase tracking-[.17em] text-[#8ea2b0]">Prayag India / Product overview</span><span className="font-display text-[1.5vw] font-semibold tracking-[.16em] text-[#f3b44b]">18 / 18</span></div>
    </div>
  );
}