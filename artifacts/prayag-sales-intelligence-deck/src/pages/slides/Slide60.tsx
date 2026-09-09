import { BrandMark, Footer } from '../../DeckShared';

const base = import.meta.env.BASE_URL;

export default function Slide60() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-[#08121f]">
      <img src={`${base}control-room.jpg`} crossOrigin="anonymous" alt="Abstract blue sales intelligence control room" className="hero-image absolute inset-0 h-full w-full object-cover opacity-30" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(8,18,31,.98)_0%,rgba(8,18,31,.78)_62%,rgba(8,18,31,.35)_100%)]" />
      <div className="absolute left-[7vw] top-[7vh]"><BrandMark /></div>
      
      <div className="absolute left-[7vw] top-[32vh]">
        <div className="eyebrow text-[#4ccfa3]">CONCLUSION</div>
        <h1 className="display-head-xl mt-[2.5vh] max-w-[65vw]">The Operational Review Loop</h1>
        <div className="mt-[4vh] h-[.18vw] w-[17vw] bg-[#f3b44b]" />
        <p className="mt-[3vh] font-display text-[2.4vw] font-medium tracking-[-.04em] text-[#e1ebef] max-w-[50vw] leading-tight">
          From headline to root cause, from risk to intervention. An exhaustively connected view of field reality.
        </p>
      </div>

      <Footer number={60} section="Prayag India / Closing" />
    </div>
  );
}
