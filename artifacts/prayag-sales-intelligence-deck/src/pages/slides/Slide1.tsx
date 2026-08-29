import { BrandMark } from '../../DeckShared';

const base = import.meta.env.BASE_URL;

export default function Slide1() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-[#08121f]">
      <img src={`${base}control-room.jpg`} crossOrigin="anonymous" alt="Abstract blue sales intelligence control room" className="hero-image absolute inset-0 h-full w-full object-cover opacity-60" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(8,18,31,.98)_0%,rgba(8,18,31,.84)_43%,rgba(8,18,31,.22)_100%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(8,18,31,.75)_0%,transparent_45%)]" />
      <div className="absolute left-[7vw] top-[6vh]"><BrandMark /></div>
      <div className="absolute left-[7vw] top-[33vh] max-w-[54vw]">
        <div className="eyebrow">PRAYAG / FIELD SALES OPERATING SYSTEM</div>
        <h1 className="display-head-xl mt-[2.4vh] text-[#f5f2ea]">Prayag Sales Intelligence</h1>
        <div className="mt-[4vh] h-[.18vw] w-[17vw] bg-[#f3b44b]" />
        <p className="mt-[3vh] max-w-[42vw] font-display text-[2.2vw] font-medium leading-[1.14] tracking-[-.035em] text-[#dce8ee]">
          Turn sales data into the next best action.
        </p>
        <p className="mt-[1.6vh] max-w-[39vw] body-copy text-[#9eb1bd]">
          A connected decision workspace for performance, coverage, customers, and growth.
        </p>
      </div>
      <div className="absolute bottom-[7vh] left-[7vw] flex items-center gap-[1.2vw] text-[1.5vw] uppercase tracking-[.18em] text-[#8296a5]">
        <span>Product overview</span><span className="h-[.5vw] w-[.5vw] rounded-full bg-[#f3b44b]" /><span>18 slides</span>
      </div>
    </div>
  );
}